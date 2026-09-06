#!/usr/bin/env python3
"""渲染层无头 UI 验证：注入 mock 桥，驱动 便签/把手/Toast/设置 四视图截图并断言 DOM。
假数据日期相对"今天"动态生成，任何日期跑都成立；v1.2.0 起含每日任务场景。"""
import datetime
import json
import pathlib
import sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path("/home/z/my-project/snapnote/renderer")
OUT = ROOT.parent / "verify"
OUT.mkdir(exist_ok=True)

TODAY = datetime.date.today()
YESTERDAY = TODAY - datetime.timedelta(days=1)
TOMORROW = TODAY + datetime.timedelta(days=1)


def iso(day, hm):
    return f"{day.isoformat()}T{hm}:00"


MOCK_STATE = {
    "tasks": [
        # 昨天忘了勾的（过期红胶囊）
        {"id": "t1", "title": "给客户回电话", "dueAt": iso(YESTERDAY, "23:30"), "done": False, "notified": False},
        # 今天晚些时候（计入徽标）
        {"id": "t2", "title": "部门周会 · 会议室 A", "dueAt": iso(TODAY, "23:50"), "done": False, "notified": False},
        # 每日任务：已滚动到明天 09:00，未打卡 → 绿胶囊 + 计入徽标
        {"id": "t5", "title": "吃维生素", "dueAt": iso(TOMORROW, "09:00"), "done": False, "notified": False, "repeat": "daily"},
        # 每日任务：今天已打卡 → 绿胶囊带"今天已完成"，不计入徽标
        {"id": "t6", "title": "晨间拉伸", "dueAt": iso(TOMORROW, "07:30"), "done": True, "completedAt": iso(TODAY, "07:31"), "notified": False, "repeat": "daily"},
        # 无时间 / 已完成沉底
        {"id": "t3", "title": "买周五的火车票", "dueAt": None, "done": False, "notified": False},
        {"id": "t4", "title": "昨天忘了的旧任务", "dueAt": iso(YESTERDAY, "18:00"), "done": True, "notified": True},
    ],
    "settings": {"hotkey": "Ctrl+Alt+N", "autostart": True, "sound": False,
                 "collapseDelay": 30, "startupToast": True},
    "mode": "handle", "hotkeyActive": True,
}

MOCK = """
window.__SNAPNOTE_MOCK__ = {
  _state: %s,
  _pushCbs: [], _modeCbs: [], _toastCbs: [], _dueCbs: [], _added: [],
  ready: async function(){ return JSON.parse(JSON.stringify(this._state)); },
  onPush: function(cb){ this._pushCbs.push(cb); },
  onViewMode: function(cb){ this._modeCbs.push(cb); },
  onDueAlert: function(cb){ this._dueCbs.push(cb); },
  onToast: function(cb){ this._toastCbs.push(cb); },
  expand: function(){ this._modeCbs.forEach(function(c){c('note');}); },
  dock: function(){ this._modeCbs.forEach(function(c){c('handle');}); },
  keepalive: function(){}, idle: function(){},
  addTask: async function(title, dueAt, repeat){
    this._added.push({title: title, dueAt: dueAt, repeat: repeat || null});
    this._state.tasks.unshift({id:'t'+Date.now(), title:title, dueAt:dueAt||null,
      repeat: repeat || null, done:false, notified:false});
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

        # 1) 把手态：徽标 = 过期1 + 今天1 + 每日未打卡1（每日已打卡不计）
        assert page.evaluate("document.body.className") == "mode-handle", "初始应为把手态"
        badge = page.inner_text("#handleBadge")
        assert badge == "3", f"徽标应为3项（过期+今天+每日未打卡），实际 {badge}"
        page.screenshot(path=str(OUT / "ui_handle.png"))

        # 2) 展开态：6 条任务行；1 红（过期）+2 绿（每日）
        page.click("#handle")
        page.wait_for_timeout(350)
        assert page.evaluate("document.body.className") == "mode-note", "点击把手应展开"
        rows = page.locator(".task").count()
        assert rows == 6, f"应有6条任务行，实际 {rows}"
        pills = page.locator(".duepill.overdue").count()
        assert pills == 1, f"应有1个过期红胶囊，实际 {pills}"
        daily_pills = page.locator(".duepill.daily")
        assert daily_pills.count() == 2, f"应有2个每日绿胶囊，实际 {daily_pills.count()}"
        assert "每天 09:00" in daily_pills.nth(0).inner_text(), \
            f"每日胶囊应显示时刻，实际 {daily_pills.nth(0).inner_text()}"
        assert "今天已完成" in daily_pills.nth(1).inner_text(), \
            f"已打卡的每日胶囊应带今天已完成，实际 {daily_pills.nth(1).inner_text()}"
        page.screenshot(path=str(OUT / "ui_note.png"))

        # 3) 录入一次性任务（含时间胶囊）
        page.fill("#taskInput", "晚上买咖啡豆")
        page.locator(".chip", has_text="今晚").first.click()
        page.press("#taskInput", "Enter")
        page.wait_for_timeout(250)
        assert page.evaluate("document.getElementById('taskInput').value") == "", "回车后输入框应清空"
        assert page.locator(".task", has_text="晚上买咖啡豆").count() == 1, "新任务应出现在列表"
        assert page.locator(".task", has_text="晚上买咖啡豆").locator(".duepill.daily").count() == 0, \
            "未开每天开关时不应有每日胶囊"

        # 4) 录入每日任务：开关 → 胶囊文案变形 → 提交 → repeat 透传
        page.fill("#taskInput", "睡前冥想")
        page.click("#repeatToggle")
        assert page.evaluate("document.getElementById('repeatToggle').classList.contains('on')"), "每天开关应有激活态"
        daily_chip = page.locator(".chips .chip", has_text="每天 2")
        assert daily_chip.count() >= 1, f"开每天后胶囊文案应变形为「每天 2x:xx」，实际 {page.locator('.chips .chip').all_inner_texts()}"
        daily_chip.first.click()
        page.press("#taskInput", "Enter")
        page.wait_for_timeout(250)
        added = page.evaluate("window.__SNAPNOTE_MOCK__._added.pop()")
        assert added["repeat"] == "daily", f"repeat 应透传 daily，实际 {added}"
        new_pill = page.locator(".task", has_text="睡前冥想").locator(".duepill.daily")
        assert new_pill.count() == 1, "新每日任务应带绿胶囊"
        assert "每天 2" in new_pill.inner_text(), f"胶囊应显示每天时刻，实际 {new_pill.inner_text()}"
        # 提交后开关复位
        assert not page.evaluate("document.getElementById('repeatToggle').classList.contains('on')"), "提交后每天开关应复位"
        page.screenshot(path=str(OUT / "ui_note_daily.png"))

        # 5) 勾选完成 → 划线沉底
        page.locator(".task", has_text="给客户回电话").locator(".tcheck").click()
        page.wait_for_timeout(250)
        assert page.locator(".task.done .ttitle", has_text="给客户回电话").count() == 1, "完成后应划线"
        page.screenshot(path=str(OUT / "ui_note_added.png"))

        # 6) Toast 视图
        tpage = browser.new_page(viewport={"width": 380, "height": 132})
        tpage.add_init_script(MOCK)
        tpage.goto((ROOT / "toast.html").as_uri())
        tpage.wait_for_timeout(200)
        tpage.evaluate("""() => {
            const api = window.__SNAPNOTE_MOCK__;
            api._toastCbs.forEach(cb => cb({title: '早上好，今天有 4 个任务', body: '最早 09:00 吃维生素'}));
        }""")
        tpage.wait_for_timeout(300)
        assert "早上好" in tpage.inner_text("#title"), "Toast 标题应已填充"
        tpage.screenshot(path=str(OUT / "ui_toast.png"))

        # 7) 设置视图
        spage = browser.new_page(viewport={"width": 460, "height": 560})
        spage.add_init_script(MOCK)
        spage.goto((ROOT / "settings.html").as_uri())
        spage.wait_for_timeout(300)
        assert spage.input_value("#delayInput") == "30", "收起延时默认应为30秒"
        spage.screenshot(path=str(OUT / "ui_settings.png"))

        browser.close()
    print("UI-VERIFY PASS (handle/note/add/daily/done/toast/settings)")
    return 0

if __name__ == "__main__":
    sys.exit(main())
