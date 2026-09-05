#!/usr/bin/env python3
"""渲染层无头 UI 验证：注入 mock 桥，驱动 便签/把手/Toast/设置 四视图截图并断言 DOM。"""
import json
import pathlib
import sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path("/home/z/my-project/snapnote/renderer")
OUT = ROOT.parent / "verify"
OUT.mkdir(exist_ok=True)

MOCK_STATE = {
    "tasks": [
        {"id": "t1", "title": "给客户回电话", "dueAt": "2026-09-04T23:30:00", "done": False, "notified": False},
        {"id": "t2", "title": "部门周会 · 会议室 A", "dueAt": "2026-09-04T09:30:00", "done": False, "notified": True},
        {"id": "t3", "title": "买周五的火车票", "dueAt": None, "done": False, "notified": False},
        {"id": "t4", "title": "昨天忘了的旧任务", "dueAt": "2026-09-03T18:00:00", "done": True, "notified": True},
    ],
    "settings": {"hotkey": "Ctrl+Alt+N", "autostart": True, "sound": False,
                  "collapseDelay": 30, "startupToast": True},
    "mode": "handle", "hotkeyActive": True,
}

MOCK = """
window.__SNAPNOTE_MOCK__ = {
  _state: %s,
  _pushCbs: [], _modeCbs: [], _toastCbs: [], _dueCbs: [],
  ready: async function(){ return JSON.parse(JSON.stringify(this._state)); },
  onPush: function(cb){ this._pushCbs.push(cb); },
  onViewMode: function(cb){ this._modeCbs.push(cb); },
  onDueAlert: function(cb){ this._dueCbs.push(cb); },
  onToast: function(cb){ this._toastCbs.push(cb); },
  expand: function(){ this._modeCbs.forEach(function(c){c('note');}); },
  dock: function(){ this._modeCbs.forEach(function(c){c('handle');}); },
  keepalive: function(){}, idle: function(){},
  addTask: async function(title, dueAt){
    this._state.tasks.unshift({id:'t'+Date.now(), title:title, dueAt:dueAt||null, done:false});
    var s = Object.assign({}, this._state);
    this._pushCbs.forEach(function(cb){ cb(s); });
    return this._state.tasks[0];
  },
  toggleTask: async function(id){ var t=this._state.tasks.find(function(x){return x.id===id;});
    if(t){t.done=!t.done; var s=Object.assign({},this._state); this._pushCbs.forEach(function(cb){cb(s);});} },
  removeTask: async function(id){ this._state.tasks = this._state.tasks.filter(function(x){return x.id!==id;});
    var s=Object.assign({},this._state); this._pushCbs.forEach(function(cb){cb(s);}); },
  getSettings: async function(){ return JSON.parse(JSON.stringify(this._state.settings)); },
  setSettings: async function(p){ Object.assign(this._state.settings, p);
    var s=Object.assign({},this._state); this._pushCbs.forEach(function(cb){cb(s);}); return this._state.settings; },
  openSettings: function(){}, quitApp: function(){}, toastClick: function(){},
};
""" % json.dumps(MOCK_STATE, ensure_ascii=False)

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 340, "height": 560})
        page.add_init_script(MOCK)
        page.goto((ROOT / "index.html").as_uri())
        page.wait_for_timeout(400)

        # 1) 把手态
        assert page.evaluate("document.body.className") == "mode-handle", "初始应为把手态"
        badge = page.inner_text("#handleBadge")
        assert badge == "2", f"徽标应为今日2项，实际 {badge}"
        page.screenshot(path=str(OUT / "ui_handle.png"))

        # 2) 展开态
        page.click("#handle")
        page.wait_for_timeout(350)
        assert page.evaluate("document.body.className") == "mode-note", "点击把手应展开"
        rows = page.locator(".task").count()
        assert rows == 4, f"应有4条任务行，实际 {rows}"
        pills = page.locator(".duepill.overdue").count()
        assert pills == 1, f"应有1个过期红胶囊，实际 {pills}"
        page.screenshot(path=str(OUT / "ui_note.png"))

        # 3) 录入任务（含时间胶囊）
        page.fill("#taskInput", "晚上买咖啡豆")
        page.locator(".chip", has_text="今晚").first.click()
        page.press("#taskInput", "Enter")
        page.wait_for_timeout(250)
        assert page.evaluate("document.getElementById('taskInput').value") == "", "回车后输入框应清空"
        assert page.locator(".task", has_text="晚上买咖啡豆").count() == 1, "新任务应出现在列表"
        focused = page.evaluate("document.activeElement.id")
        assert focused == "taskInput", f"回车后焦点应保持在输入框，实际 {focused}"

        # 4) 勾选完成 → 划线沉底
        page.locator(".task", has_text="给客户回电话").locator(".tcheck").click()
        page.wait_for_timeout(250)
        assert page.locator(".task.done .ttitle", has_text="给客户回电话").count() == 1, "完成后应划线"
        page.screenshot(path=str(OUT / "ui_note_added.png"))

        # 5) Toast 视图
        tpage = browser.new_page(viewport={"width": 380, "height": 132})
        tpage.add_init_script(MOCK)
        tpage.goto((ROOT / "toast.html").as_uri())
        tpage.wait_for_timeout(200)
        tpage.evaluate("""() => {
            const api = window.__SNAPNOTE_MOCK__;
            api._toastCbs.forEach(cb => cb({title: '早上好，今天有 4 个任务', body: '最早 09:30 部门周会 · 会议室 A'}));
        }""")
        tpage.wait_for_timeout(300)
        assert "早上好" in tpage.inner_text("#title"), "Toast 标题应已填充"
        tpage.screenshot(path=str(OUT / "ui_toast.png"))

        # 6) 设置视图
        spage = browser.new_page(viewport={"width": 460, "height": 560})
        spage.add_init_script(MOCK)
        spage.goto((ROOT / "settings.html").as_uri())
        spage.wait_for_timeout(300)
        assert spage.input_value("#delayInput") == "30", "收起延时默认应为30秒"
        spage.screenshot(path=str(OUT / "ui_settings.png"))

        browser.close()
    print("UI-VERIFY PASS (handle/note/add/done/toast/settings)")
    return 0

if __name__ == "__main__":
    sys.exit(main())
