/* 헬스 출석 체크 — 기록과 설정은 기기 안(Capacitor Preferences)에만 저장 */
(() => {
  "use strict";
  const Preferences = window.capacitorPreferences && window.capacitorPreferences.Preferences;
  const LocalNotifications = window.capacitorLocalNotifications && window.capacitorLocalNotifications.LocalNotifications;
  const Haptics = window.capacitorHaptics && window.capacitorHaptics.Haptics;
  const ImpactStyle = window.capacitorHaptics && window.capacitorHaptics.ImpactStyle;

  const STORE_KEY = "gym-state-v1";
  const REMIND_ID = 1001;
  const $ = id => document.getElementById(id);
  const pad = n => String(n).padStart(2, "0");
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const md = s => { const [, m, d] = s.split("-"); return `${+m}/${+d}`; };

  /* ---------- state ---------- */
  // periods: { "<시작일 ISO>": { start, end, limit, days: ["YYYY-MM-DD", ...] } }
  let state = { startDay: 20, limit: 15, remind: false, remindTime: "19:00", periods: {} };

  async function load() {
    try {
      const raw = Preferences ? (await Preferences.get({ key: STORE_KEY })).value : localStorage.getItem(STORE_KEY);
      if (raw) state = Object.assign(state, JSON.parse(raw));
    } catch (e) { /* 처음 실행 */ }
  }
  let saving = Promise.resolve();
  function save() {
    const value = JSON.stringify(state);
    saving = saving.then(() => Preferences ? Preferences.set({ key: STORE_KEY, value }) : localStorage.setItem(STORE_KEY, value)).catch(() => {});
    return saving;
  }

  /* ---------- 기간 계산 ---------- */
  const now = () => new Date();
  let navY, navM;          // 보고 있는 기간의 시작 연·월
  function resetNav() {
    const t = now();
    navY = t.getFullYear(); navM = t.getMonth();
    if (t.getDate() < state.startDay) { if (--navM < 0) { navM = 11; navY--; } }
  }
  const pStart = () => new Date(navY, navM, state.startDay);
  const pEnd = () => new Date(navY, navM + 1, state.startDay - 1);
  const pKey = () => iso(pStart());
  function currentPeriod() {
    const k = pKey();
    return state.periods[k] || { start: k, end: iso(pEnd()), limit: state.limit, days: [] };
  }
  function todayPeriod() {
    const y = navY, m = navM; resetNav();
    const p = currentPeriod(); navY = y; navM = m; return p;
  }

  /* ---------- 출석 화면 ---------- */
  const C = 2 * Math.PI * 52;
  $("bar").style.strokeDasharray = C;

  function renderCheck() {
    const p = currentPeriod();
    const days = p.days.slice().sort();
    const limit = p.limit;
    const left = Math.max(0, limit - days.length);
    $("left").textContent = left;
    $("used").textContent = days.length;
    $("limit").textContent = limit;
    $("ring").classList.toggle("zero", left === 0);
    $("bar").style.strokeDashoffset = C * (1 - left / limit);

    const s = pStart(), e = pEnd();
    $("period").textContent = `${s.getMonth() + 1}월 ${s.getDate()}일 ~ ${e.getMonth() + 1}월 ${e.getDate()}일`;
    const t = now(); const t0 = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    $("dleft").textContent = t0 < s ? "시작 전" : t0 > e ? "종료됨" : `${Math.round((e - t0) / 864e5) + 1}일 남음`;
    $("last").textContent = days.length ? md(days[days.length - 1]).replace("/", "월 ") + "일" : "아직 없음";

    const g = $("grid"); g.innerHTML = "";
    ["일", "월", "화", "수", "목", "금", "토"].forEach((w, i) => {
      const d = document.createElement("div"); d.className = "dow" + (i === 0 ? " sun" : ""); d.textContent = w; g.appendChild(d);
    });
    const todayIso = iso(t);
    let cur = -1;
    for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
      if (d.getMonth() !== cur) {
        cur = d.getMonth();
        const lab = document.createElement("div"); lab.className = "mlabel";
        lab.textContent = `${d.getFullYear()}년 ${d.getMonth() + 1}월`; g.appendChild(lab);
        for (let i = 0; i < d.getDay(); i++) g.appendChild(document.createElement("div"));
      }
      const k = iso(d), on = days.includes(k);
      const b = document.createElement("button");
      b.className = "day" + (on ? " on" : "") + (!on && left === 0 ? " blocked" : "") + (k === todayIso ? " today" : "");
      b.textContent = d.getDate();
      b.setAttribute("aria-pressed", on);
      b.setAttribute("aria-label", `${d.getMonth() + 1}월 ${d.getDate()}일${on ? " 다녀옴" : ""}`);
      b.onclick = () => toggle(k);
      g.appendChild(b);
    }
  }
  function hint(text, err) { $("hint").textContent = text; $("hint").classList.toggle("err", !!err); }
  const HINT = "날짜를 누르면 체크, 다시 누르면 취소돼요.";

  async function toggle(day) {
    const p = currentPeriod();
    const days = p.days.slice();
    const i = days.indexOf(day);
    if (i >= 0) days.splice(i, 1);
    else if (days.length >= p.limit) { hint(`이번 기간 ${p.limit}회를 모두 사용했어요.`, true); buzz("warn"); return; }
    else days.push(day);
    const k = pKey();
    if (days.length) state.periods[k] = Object.assign({}, p, { days });
    else delete state.periods[k];
    hint(HINT); buzz(i >= 0 ? "light" : "medium");
    render(); await save(); scheduleReminder();
  }

  /* ---------- 기록 화면 ---------- */
  function renderLog() {
    const keys = Object.keys(state.periods).filter(k => state.periods[k].days.length).sort().reverse();
    const list = $("list"); list.innerHTML = "";
    if (!keys.length) { list.innerHTML = '<div class="empty">아직 기록이 없어요.<br>출석 탭에서 다녀온 날을 눌러 보세요.</div>'; return; }
    keys.forEach(k => {
      const p = state.periods[k], days = p.days.slice().sort();
      const row = document.createElement("div"); row.className = "row";
      row.innerHTML = '<div class="row-top"><b></b><span></span></div><div class="mini"></div><div class="dates"></div>';
      row.querySelector("b").textContent = `${md(p.start)} ~ ${md(p.end)}`;
      row.querySelector(".row-top span").textContent = `${days.length}회 사용 · ${Math.max(0, p.limit - days.length)}회 남음`;
      const mini = row.querySelector(".mini");
      for (let i = 0; i < p.limit; i++) { const x = document.createElement("i"); if (i < days.length) x.className = "on"; mini.appendChild(x); }
      row.querySelector(".dates").textContent = days.map(md).join(" · ");
      list.appendChild(row);
    });
  }

  /* ---------- 설정 화면 ---------- */
  for (let d = 1; d <= 28; d++) { const o = document.createElement("option"); o.value = d; o.textContent = `${d}일`; $("startDay").appendChild(o); }
  function renderSet() {
    if ($("remindCard")) $("remindCard").hidden = !LocalNotifications;
    $("startDay").value = state.startDay;
    $("range-desc").textContent = state.startDay === 1 ? "매달 1일 ~ 말일" : `매달 ${state.startDay}일 ~ 다음 달 ${state.startDay - 1}일`;
    $("limVal").textContent = state.limit;
    $("remind").checked = state.remind;
    $("remindTime").value = state.remindTime;
    $("timeRow").hidden = !state.remind;
  }
  $("startDay").onchange = async e => { state.startDay = +e.target.value; resetNav(); render(); await save(); scheduleReminder(); };
  function setLimit(n) {
    state.limit = Math.min(31, Math.max(1, n));
    // 지금 기간의 횟수도 함께 바꾼다 (이미 다녀온 횟수보다 작게는 못 줄임)
    const p = todayPeriod(); const k = p.start;
    if (state.periods[k]) state.periods[k].limit = Math.max(state.limit, state.periods[k].days.length);
    render(); save(); scheduleReminder();
  }
  $("limDown").onclick = () => setLimit(state.limit - 1);
  $("limUp").onclick = () => setLimit(state.limit + 1);
  $("remind").onchange = async e => {
    state.remind = e.target.checked;
    if (state.remind && LocalNotifications) {
      const perm = await LocalNotifications.requestPermissions().catch(() => ({ display: "denied" }));
      if (perm.display !== "granted") {
        state.remind = false; $("setHint").textContent = "알림이 꺼져 있어요. 아이폰 설정 > 알림에서 이 앱을 허용해 주세요.";
      } else $("setHint").textContent = "";
    }
    render(); await save(); scheduleReminder();
  };
  $("remindTime").onchange = async e => { state.remindTime = e.target.value || "19:00"; await save(); scheduleReminder(); };

  let armed = false;
  $("reset").onclick = async () => {
    if (!armed) { armed = true; $("reset").textContent = "한 번 더 누르면 모두 지워져요"; $("reset").classList.add("confirm"); return; }
    state.periods = {}; armed = false; render(); await save(); scheduleReminder();
  };
  function disarm() { armed = false; $("reset").textContent = "모든 기록 지우기"; $("reset").classList.remove("confirm"); }

  /* ---------- 알림 ---------- */
  async function scheduleReminder() {
    if (!LocalNotifications) return;
    try {
      await LocalNotifications.cancel({ notifications: [{ id: REMIND_ID }] });
      if (!state.remind) return;
      const p = todayPeriod();
      const left = Math.max(0, p.limit - p.days.length);
      const [h, m] = state.remindTime.split(":").map(Number);
      await LocalNotifications.schedule({ notifications: [{
        id: REMIND_ID,
        title: "오늘 운동하러 가볼까요?",
        body: left > 0 ? `이번 기간 ${left}회 남았어요. 다녀오면 앱에서 체크해 주세요.` : "이번 기간 횟수를 모두 사용했어요. 수고했어요!",
        schedule: { on: { hour: h, minute: m }, allowWhileIdle: true }
      }] });
    } catch (e) { /* 알림을 쓸 수 없는 환경 */ }
  }

  /* ---------- 햅틱 ---------- */
  function buzz(kind) {
    if (!Haptics) return;
    try {
      if (kind === "warn") Haptics.notification({ type: "WARNING" });
      else Haptics.impact({ style: kind === "light" ? ImpactStyle.Light : ImpactStyle.Medium });
    } catch (e) {}
  }

  /* ---------- 탭 ---------- */
  const TITLES = { check: "출석", log: "기록", set: "설정" };
  document.querySelectorAll(".tab").forEach(btn => btn.onclick = () => {
    const name = btn.dataset.tab;
    ["check", "log", "set"].forEach(n => $("screen-" + n).hidden = n !== name);
    document.querySelectorAll(".tab").forEach(b => b.setAttribute("aria-selected", b === btn));
    $("title").textContent = TITLES[name];
    disarm(); window.scrollTo(0, 0);
  });
  $("prev").onclick = () => { if (--navM < 0) { navM = 11; navY--; } hint(HINT); renderCheck(); };
  $("next").onclick = () => { if (++navM > 11) { navM = 0; navY++; } hint(HINT); renderCheck(); };

  function render() { renderCheck(); renderLog(); renderSet(); }

  // 앱을 다시 열면 오늘 기준 기간으로 돌아간다
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { resetNav(); render(); } });

  (async () => { await load(); resetNav(); render(); scheduleReminder(); })();
})();
