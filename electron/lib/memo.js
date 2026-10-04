'use strict';
/**
 * SnapNote 备忘录存储层（v1.5.0）
 * - memo.json 存放于应用数据目录（与 tasks.json 同目录，独立文件互不干扰）
 * - 原子写入（tmp + rename）+ .bak 备份，损坏自动回退（与 store.js 同模式）
 * - 分类树：parentId 链，无限层级；「快速收集」为内置根分类（不可删除）
 * - 图片资产：只存元数据（hash/尺寸），像素文件由主进程落盘 memo-assets/
 * - 纯 CommonJS，无 Electron 依赖，可被单元测试直接加载
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MEMO_SCHEMA = 1;

/** 内置根分类（id 固定，不可删除；收集快捷键的默认归宿） */
const ROOT_CATEGORY_ID = 'cat-root';
const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 同内容 10 分钟内重复收集判定为重复

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** 默认分类树（首次启动初始化；用户可自由增删改名，仅「快速收集」受保护） */
function defaultCategories() {
  const now = new Date().toISOString();
  return [
    { id: ROOT_CATEGORY_ID, name: '快速收集', parentId: null, order: 0, locked: true, createdAt: now },
    { id: 'cat-work', name: '工作', parentId: null, order: 1, createdAt: now },
    { id: 'cat-life', name: '生活', parentId: null, order: 2, createdAt: now },
    { id: 'cat-idea', name: '灵感', parentId: null, order: 3, createdAt: now },
  ];
}

class MemoStore {
  /**
   * @param {string} [baseDir] 数据目录；生产环境传 app.getPath('userData')
   */
  constructor(baseDir) {
    this.baseDir = baseDir || path.join(process.env.APPDATA || process.env.HOME || '.', 'SnapNote');
    this.memoFile = path.join(this.baseDir, 'memo.json');
    this.assetsDir = path.join(this.baseDir, 'memo-assets');
    this.categories = [];
    this.items = [];
    this.recentCatIds = []; // 最近归档使用（气泡默认选中），长度 4
    this._load();
  }

  _readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      try {
        return JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
      } catch (e2) {
        return fallback;
      }
    }
  }

  _writeJson(file, data) {
    try { fs.mkdirSync(this.baseDir, { recursive: true }); } catch (e) { /* ignore */ }
    const tmp = file + '.tmp';
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
    } catch (e) { /* bak 尽力而为 */ }
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  _load() {
    const d = this._readJson(this.memoFile, null);
    if (d && typeof d === 'object') {
      this.categories = Array.isArray(d.categories) ? d.categories : [];
      this.items = Array.isArray(d.items) ? d.items : [];
      this.recentCatIds = Array.isArray(d.recentCatIds) ? d.recentCatIds : [];
    } else {
      // 首次启动：初始化默认分类树
      this.categories = defaultCategories();
      this.recentCatIds = [];
      this.items = [];
      this.persist();
    }
    // 数据自愈：保证内置根分类存在（文件被手动清空等场景）
    if (!this.categories.some(c => c.id === ROOT_CATEGORY_ID)) {
      this.categories.unshift(defaultCategories()[0]);
      this.persist();
    }
  }

  persist() {
    this._writeJson(this.memoFile, {
      schema: MEMO_SCHEMA,
      categories: this.categories,
      items: this.items,
      recentCatIds: this.recentCatIds,
    });
  }

  // ------------------------------------------------------------ 分类

  _cat(id) { return this.categories.find(c => c.id === id) || null; }

  /** 同层重名检测 */
  _nameTaken(name, parentId) {
    const n = String(name).trim();
    return this.categories.some(c => c.parentId === parentId && c.name === n);
  }

  _siblingMaxOrder(parentId) {
    const sibs = this.categories.filter(c => c.parentId === parentId);
    return sibs.length ? Math.max(...sibs.map(c => c.order || 0)) : -1;
  }

  addCategory(name, parentId) {
    const n = String(name || '').trim().slice(0, 30);
    if (!n) return null;
    const pid = parentId || null;
    if (pid !== null && !this._cat(pid)) return null; // 父分类不存在
    if (this._nameTaken(n, pid)) return null;
    const cat = {
      id: newId('cat-'),
      name: n,
      parentId: pid,
      order: this._siblingMaxOrder(pid) + 1,
      createdAt: new Date().toISOString(),
    };
    this.categories.push(cat);
    this.persist();
    return cat;
  }

  renameCategory(id, name) {
    const c = this._cat(id);
    if (!c) return false;
    const n = String(name || '').trim().slice(0, 30);
    if (!n || this._nameTaken(n, c.parentId)) return false;
    c.name = n;
    this.persist();
    return true;
  }

  /** id 的子孙 id 集合（含自身） */
  _subtreeIds(id) {
    const out = [id];
    const walk = (pid) => {
      for (const c of this.categories) {
        if (c.parentId === pid) { out.push(c.id); walk(c.id); }
      }
    };
    walk(id);
    return out;
  }

  /** 移动分类到新父分类。环防护：目标不得是自身或自身子孙。 */
  moveCategory(id, newParentId) {
    const c = this._cat(id);
    if (!c) return false;
    const npid = newParentId || null;
    if (npid === id) return false;
    if (npid !== null) {
      if (!this._cat(npid)) return false;
      if (this._subtreeIds(id).includes(npid)) return false; // 环
    }
    if (c.parentId === npid) return true; // 无变化
    c.parentId = npid;
    c.order = this._siblingMaxOrder(npid) + 1;
    this.persist();
    return true;
  }

  /** 同层上移/下移（order 交换） */
  reorderCategory(id, dir) {
    const c = this._cat(id);
    if (!c) return false;
    const sibs = this.categories.filter(x => x.parentId === c.parentId)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    const idx = sibs.findIndex(x => x.id === id);
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sibs.length) return false;
    const a = sibs[idx], b = sibs[swapIdx];
    const t = a.order; a.order = b.order; b.order = t;
    this.persist();
    return true;
  }

  /**
   * 删除分类。deleteItems=false 时：直接子分类提级到被删分类的父级
   * （深层子随各自父走，层级语义保留），条目移入父分类（null=未分类）；
   * deleteItems=true 时：递归删除子分类及其全部条目。
   * 「快速收集」（locked）不可删。
   */
  removeCategory(id, deleteItems) {
    const c = this._cat(id);
    if (!c || c.locked) return false;
    const subIds = new Set(this._subtreeIds(id));
    if (deleteItems) {
      this.categories = this.categories.filter(x => !subIds.has(x.id));
      this.items = this.items.filter(x => !subIds.has(x.categoryId));
    } else {
      // 仅直接子分类提级；深层子随各自父走（层级语义保留）
      for (const x of this.categories) {
        if (x.parentId === id) x.parentId = c.parentId;
      }
      // 仅"直接存放在被删分类"的条目移入父分类（null=未分类）；
      // 子孙分类未被删，其中的条目不动（曾误将整棵子树的条目全部平移——测试抓出）
      for (const it of this.items) {
        if (it.categoryId === id) it.categoryId = c.parentId;
      }
      this.categories = this.categories.filter(x => x.id !== id);
    }
    this.recentCatIds = this.recentCatIds.filter(cid => this._cat(cid));
    this.persist();
    return true;
  }

  /** 分类平铺（渲染树用）：含 depth、条目数（含子孙） */
  categoriesFlat() {
    const countOf = (id) => {
      const sub = new Set(this._subtreeIds(id));
      return this.items.filter(it => sub.has(it.categoryId)).length;
    };
    const out = [];
    const walk = (parentId, depth) => {
      const sibs = this.categories.filter(c => c.parentId === parentId)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      for (const c of sibs) {
        out.push({ ...c, depth, count: countOf(c.id) });
        walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }

  /** 分类面包屑路径：['工作', '文档'] */
  pathOf(id) {
    const out = [];
    let cur = this._cat(id);
    while (cur) { out.unshift(cur.name); cur = this._cat(cur.parentId); }
    return out;
  }

  // ------------------------------------------------------------ 条目

  /**
   * 新增条目。返回 item，或 { duplicate: true }（10 分钟内同内容重复收集）。
   * @param {object} p { type:'text'|'image', text, categoryId, imageHash, imageW, imageH,
   *                    source, url, sensitive, note }
   */
  addItem(p) {
    const type = p.type === 'image' ? 'image' : 'text';
    if (type === 'text') {
      const text = String(p.text || '').trim();
      if (!text) return null;
      const fp = sha256(text);
      const dup = this.items.find(it =>
        it.type === 'text'
        && it.fingerprint === fp
        && Date.now() - Date.parse(it.createdAt) < DEDUP_WINDOW_MS);
      if (dup) return { duplicate: true };
      const item = {
        id: newId('m-'),
        type: 'text',
        text: text.slice(0, 20000),
        fingerprint: fp,
        categoryId: this._validCat(p.categoryId),
        source: p.source || 'manual',
        url: p.url || null,
        sensitive: !!p.sensitive,
        note: String(p.note || '').slice(0, 2000) || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.items.push(item);
      this.persist();
      return item;
    }
    // image
    const hash = String(p.imageHash || '').trim();
    if (!hash) return null;
    const dup = this.items.find(it =>
      it.type === 'image'
      && it.imageHash === hash
      && Date.now() - Date.parse(it.createdAt) < DEDUP_WINDOW_MS);
    if (dup) return { duplicate: true };
    const item = {
      id: newId('m-'),
      type: 'image',
      imageHash: hash,
      imageW: Number(p.imageW) || 0,
      imageH: Number(p.imageH) || 0,
      fingerprint: sha256('img:' + hash),
      categoryId: this._validCat(p.categoryId),
      source: p.source || 'manual',
      url: p.url || null,
      sensitive: !!p.sensitive,
      note: String(p.note || '').slice(0, 2000) || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.items.push(item);
    this.persist();
    return item;
  }

  _validCat(id) {
    return (id && this._cat(id)) ? id : ROOT_CATEGORY_ID;
  }

  updateItem(id, patch) {
    const it = this.items.find(x => x.id === id);
    if (!it) return null;
    if (Object.prototype.hasOwnProperty.call(patch, 'text') && it.type === 'text') {
      const t = String(patch.text || '').trim();
      if (t) { it.text = t.slice(0, 20000); it.fingerprint = sha256(t); }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'note')) {
      it.note = String(patch.note || '').slice(0, 2000) || null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'sensitive')) {
      it.sensitive = !!patch.sensitive;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'categoryId')) {
      // 显式 null = 移入「未分类」（合法操作）；无效 id 则拒改保持原值
      // （addItem 用 _validCat 兜底是合理的——新条目不落空；移动必须尊重调用方意图）
      const v = patch.categoryId;
      it.categoryId = (v === null || v === undefined) ? null : (this._cat(v) ? v : it.categoryId);
    }
    it.updatedAt = new Date().toISOString();
    this.persist();
    return it;
  }

  removeItem(id) {
    const before = this.items.length;
    this.items = this.items.filter(x => x.id !== id);
    if (this.items.length !== before) { this.persist(); return true; }
    return false;
  }

  moveItem(id, categoryId) {
    return this.updateItem(id, { categoryId });
  }

  /** 条目列表（倒序）。categoryId: 'all' | null(未分类) | 具体 id */
  list(opts) {
    const o = opts || {};
    let arr = [...this.items];
    if (o.categoryId === 'all') {
      // 全部
    } else if (o.categoryId == null) {
      arr = arr.filter(it => !this._cat(it.categoryId)); // 未分类（分类被删残留）
    } else {
      const sub = new Set(this._subtreeIds(o.categoryId));
      arr = arr.filter(it => sub.has(it.categoryId));
    }
    if (o.type === 'text' || o.type === 'image') arr = arr.filter(it => it.type === o.type);
    const q = String(o.q || '').trim().toLowerCase();
    if (q) {
      arr = arr.filter(it =>
        (it.text || '').toLowerCase().includes(q)
        || (it.note || '').toLowerCase().includes(q)
        || (it.url || '').toLowerCase().includes(q));
    }
    // 倒序（最新在前）；createdAt 同刻时用插入序 tie-break（同毫秒连续收集很常见）
    const seqOf = new Map(this.items.map((it, i) => [it.id, i]));
    arr.sort((a, b) => {
      const d = String(b.createdAt).localeCompare(String(a.createdAt));
      return d !== 0 ? d : (seqOf.get(b.id) || 0) - (seqOf.get(a.id) || 0);
    });
    return arr;
  }

  counts() {
    const uncategorized = this.items.filter(it => !this._cat(it.categoryId)).length;
    return { all: this.items.length, uncategorized };
  }

  item(id) { return this.items.find(x => x.id === id) || null; }

  /** 记录最近归档使用的分类（气泡/快捷键默认值），容量 4 */
  touchCategory(id) {
    if (!this._cat(id)) return;
    this.recentCatIds = [id, ...this.recentCatIds.filter(c => c !== id)].slice(0, 4);
    this.persist();
  }
}

module.exports = {
  MemoStore,
  ROOT_CATEGORY_ID,
  DEDUP_WINDOW_MS,
  sha256,
  defaultCategories,
};
