import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copy } from "./lib/i18n";
import { loadState, saveState, dayKey, sanitizeState } from "./lib/storage";
import { fetchPrayerTimes, getNextPrayer, prayerDateTime } from "./lib/prayer";
import { askPhysics, buildAiProfileSummary } from "./lib/assistant";
import { speak, createRecognition } from "./lib/voice";
import { connectCloud, firebaseEnabled, saveCloud, watchCloud } from "./lib/firebase";

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const today = () => dayKey();
const formatTime = d => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dateLabel = (d, locale) =>
  d.toLocaleDateString(locale === "ar" ? "ar-EG" : "en-US", { weekday: "long", month: "long", day: "numeric" });

export default function App() {
  const [state, setState] = useState(() => loadState());
  const [now, setNow] = useState(() => new Date());
  const [timer, setTimer] = useState({ duration: 25 * 60, remaining: 25 * 60, running: false });
  const [customMinutesOpen, setCustomMinutesOpen] = useState(false);
  const [customMinutesInput, setCustomMinutesInput] = useState("30");
  const [keepAwake, setKeepAwake] = useState(true);
  const [taskText, setTaskText] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [wakeArmed, setWakeArmed] = useState(false);
  const [prayerError, setPrayerError] = useState("");
  const [cloudStatus, setCloudStatus] = useState("off");
  const [uidCloud, setUidCloud] = useState("");
  const [onboard, setOnboard] = useState({
    wake: "07:00",
    sleep: "23:00",
    peak: "Morning",
    priorities: "Study, personal goals",
    style: "short"
  });
  const [settingsOpen, setSettingsOpen] = useState(false);

  const recognition = useRef(null);
  const skipNextCloudPush = useRef(false);
  const completedSessionLogged = useRef(false);
  const wakeLockRef = useRef(null);

  const t = copy[state.language] || copy.en;
  const isAr = state.language === "ar";
  const currentDay = today();

  const tasksToday = useMemo(() => state.tasks.filter(x => x.date === currentDay), [state.tasks, currentDay]);
  const completed = useMemo(() => tasksToday.filter(x => x.done), [tasksToday]);
  const pending = useMemo(() => tasksToday.filter(x => !x.done), [tasksToday]);
  const focusToday = useMemo(
    () => state.sessions.filter(x => x.date === currentDay).reduce((a, x) => a + (Number(x.minutes) || 0), 0),
    [state.sessions, currentDay]
  );
  const rate = tasksToday.length ? Math.round((completed.length / tasksToday.length) * 100) : 0;
  const nextPrayer = useMemo(() => getNextPrayer(state.prayerTimes, now), [state.prayerTimes, now]);
  const countdown = nextPrayer ? Math.max(0, Math.floor((nextPrayer.at - now) / 1000)) : 0;
  const countdownText = `${String(Math.floor(countdown / 3600)).padStart(2, "0")}:${String(Math.floor((countdown % 3600) / 60)).padStart(2, "0")}:${String(countdown % 60).padStart(2, "0")}`;

  const update = useCallback(patch => {
    setState(s => sanitizeState({ ...s, ...patch }));
  }, []);

  useEffect(() => {
    saveState(state);
    if (uidCloud) {
      if (skipNextCloudPush.current) {
        skipNextCloudPush.current = false;
        return;
      }
      saveCloud(uidCloud, state).catch(e => console.warn("Cloud sync:", e));
    }
  }, [state, uidCloud]);

  // Mobile Screen Wake Lock while timer is running or wake-phrase mode is active on screen
  useEffect(() => {
    let active = true;
    async function syncWakeLock() {
      const shouldLock = keepAwake && (timer.running || wakeArmed) && document.visibilityState === "visible";
      if (shouldLock && "wakeLock" in navigator && !wakeLockRef.current) {
        try {
          const lock = await navigator.wakeLock.request("screen");
          if (!active) {
            await lock.release().catch(() => {});
            return;
          }
          wakeLockRef.current = lock;
          lock.addEventListener("release", () => {
            if (wakeLockRef.current === lock) wakeLockRef.current = null;
          });
        } catch {
          // Wake Lock unsupported or denied by browser/power state
        }
      } else if (!shouldLock && wakeLockRef.current) {
        try {
          await wakeLockRef.current.release();
        } catch {
          // Ignore release errors
        }
        wakeLockRef.current = null;
      }
    }
    syncWakeLock();
    const onVisChange = () => syncWakeLock();
    document.addEventListener("visibilitychange", onVisChange);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisChange);
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
    };
  }, [keepAwake, timer.running, wakeArmed]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!timer.running) return;
    const id = setInterval(() => {
      setTimer(x => {
        if (x.remaining <= 1) {
          clearInterval(id);
          return { ...x, remaining: 0, running: false };
        }
        return { ...x, remaining: x.remaining - 1 };
      });
    }, 1000);
    return () => clearInterval(id);
  }, [timer.running]);

  useEffect(() => {
    if (timer.remaining === 0 && timer.duration > 0 && !timer.running && !completedSessionLogged.current) {
      completedSessionLogged.current = true;
      const loggedMinutes = Math.max(1, Math.round(timer.duration / 60));
      notify(t.timerDone);
      setState(s =>
        sanitizeState({
          ...s,
          sessions: [...s.sessions, { id: uid(), date: dayKey(), minutes: loggedMinutes, at: new Date().toISOString() }]
        })
      );
      setTimer(x => ({ ...x, duration: 0 }));
    }
  }, [timer.remaining, timer.duration, timer.running, t.timerDone]);

  const loadPrayers = useCallback(async () => {
    try {
      const times = await fetchPrayerTimes(state.city, new Date(), state.prayerMethod);
      update({ prayerTimes: times, lastPrayerDate: dayKey() });
      setPrayerError("");
    } catch {
      setPrayerError(t.prayerError);
    }
  }, [state.city, state.prayerMethod, t.prayerError, update]);

  useEffect(() => {
    loadPrayers();
  }, [loadPrayers]);

  useEffect(() => {
    if (!state.profile || !state.prayerTimes) return;
    const dayStr = dayKey(now);
    for (const [name, time] of Object.entries(state.prayerTimes)) {
      const at = prayerDateTime(time, now);
      const diffMs = now.getTime() - at.getTime();
      const alertKey = `physics-prayer-${dayStr}-${name}`;
      if (diffMs >= 0 && diffMs <= 60000 && !localStorage.getItem(alertKey)) {
        localStorage.setItem(alertKey, "1");
        notify(`${name} prayer time`);
      }
    }
  }, [now, state.prayerTimes, state.profile]);

  function notify(body) {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Physics", { body, icon: "/icon.svg" });
    } else if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    if ("vibrate" in navigator) navigator.vibrate?.([180, 80, 180]);
  }

  async function enableNotifications() {
    if ("Notification" in window) {
      await Notification.requestPermission().catch(() => {});
    }
  }

  function addTask(title = taskText) {
    const clean = String(title || "").trim();
    if (!clean) return;
    setState(s =>
      sanitizeState({
        ...s,
        tasks: [...s.tasks, { id: uid(), title: clean, date: dayKey(), done: false, createdAt: new Date().toISOString() }]
      })
    );
    if (title === taskText) setTaskText("");
  }

  function toggleTask(id) {
    setState(s =>
      sanitizeState({
        ...s,
        tasks: s.tasks.map(x =>
          x.id === id ? { ...x, done: !x.done, completedAt: !x.done ? new Date().toISOString() : null } : x
        )
      })
    );
  }

  function removeTask(id) {
    setState(s => sanitizeState({ ...s, tasks: s.tasks.filter(x => x.id !== id) }));
  }

  function startTimer(minutes = 25) {
    const n = Math.max(1, Math.min(240, Number(minutes) || 25));
    completedSessionLogged.current = false;
    setTimer({ duration: n * 60, remaining: n * 60, running: true });
    setCustomMinutesOpen(false);
  }

  function pauseTimer() {
    setTimer(x => ({ ...x, running: false }));
  }

  function resetTimer() {
    const baseSec = timer.duration > 0 ? timer.duration : 25 * 60;
    completedSessionLogged.current = false;
    setTimer({ duration: baseSec, remaining: baseSec, running: false });
  }

  async function sendMessage(text = chatInput) {
    const msg = String(text || "").trim();
    if (!msg || busy) return;
    setMessages(m => [...m, { role: "user", text: msg }]);
    if (text === chatInput) setChatInput("");
    setBusy(true);
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yKey = dayKey(yesterday);
      const prevSessions = state.sessions.filter(x => x.date === yKey);
      const prevTasks = state.tasks.filter(x => x.date === yKey);
      const prevRate = prevTasks.length ? Math.round((prevTasks.filter(x => x.done).length / prevTasks.length) * 100) : 0;

      const result = await askPhysics(msg, {
        language: state.language,
        profile: state.profile,
        tasks: tasksToday,
        prayerTimes: state.prayerTimes,
        yesterdaySummary: {
          rate: prevRate,
          focusMinutes: prevSessions.reduce((a, x) => a + (Number(x.minutes) || 0), 0)
        },
        focusMinutes: focusToday
      });

      setMessages(m => [...m, { role: "assistant", text: result.text }]);
      if (result.action?.type === "timer") startTimer(result.action.minutes);
      if (result.action?.type === "complete" && result.action.id) toggleTask(result.action.id);
      if (result.action?.type === "add" && result.action.title) addTask(result.action.title);
      speak(result.text, state.language);
    } catch {
      setMessages(m => [
        ...m,
        {
          role: "assistant",
          text: isAr ? "حصلت مشكلة في الاتصال بخدمة المساعد." : "The assistant service could not be reached."
        }
      ]);
    } finally {
      setBusy(false);
    }
  }

  function armWakeWord() {
    if (wakeArmed) {
      recognition.current?.stop();
      setWakeArmed(false);
      return;
    }
    const r = createRecognition(
      state.language,
      txt => {
        if (/ (hey\s+physics|physics) |هيه\s*فيزيكس|فيزيكس/i.test(txt)) {
          const command = txt.replace(/hey\s+physics|physics|هيه\s*فيزيكس|فيزيكس/gi, "").trim();
          if (command) sendMessage(command);
          else speak(isAr ? "اتفضل، سامعك." : "I'm listening.", state.language);
        }
      },
      () => setWakeArmed(false),
      () => setWakeArmed(false),
      true
    );
    if (!r) {
      setMessages(m => [...m, { role: "assistant", text: t.voiceUnsupported }]);
      return;
    }
    recognition.current = r;
    setWakeArmed(true);
    try {
      r.start();
    } catch {
      setWakeArmed(false);
    }
  }

  function beginVoice() {
    if (listening) {
      recognition.current?.stop();
      setListening(false);
      return;
    }
    const r = createRecognition(
      state.language,
      txt => {
        setListening(false);
        sendMessage(txt);
      },
      () => setListening(false),
      () => setListening(false)
    );
    if (!r) {
      setMessages(m => [...m, { role: "assistant", text: t.voiceUnsupported }]);
      return;
    }
    recognition.current = r;
    setListening(true);
    try {
      r.start();
    } catch {
      setListening(false);
    }
  }

  function completeOnboarding() {
    const profile = buildAiProfileSummary(onboard, state.language);
    const seededTasks = profile.priorities.map(title => ({
      id: uid(),
      title,
      date: dayKey(),
      done: false,
      createdAt: new Date().toISOString()
    }));
    const defaultMins = profile.focusMinutes || 25;
    completedSessionLogged.current = false;
    setTimer({ duration: defaultMins * 60, remaining: defaultMins * 60, running: false });
    update({ profile, tasks: [...state.tasks, ...seededTasks] });
    setMessages([
      {
        role: "assistant",
        text: isAr
          ? `تم إعداد ملفك: ${profile.aiSummary} جهزت لك مهام اليوم وجلسة تركيز ${defaultMins} دقيقة.`
          : `Profile ready: ${profile.aiSummary} Added today's priorities and set your default ${defaultMins}-minute timer.`
      }
    ]);
  }

  async function connect() {
    try {
      const id = await connectCloud();
      setUidCloud(id);
      setCloudStatus("on");
      watchCloud(id, remote => {
        skipNextCloudPush.current = true;
        setState(s => sanitizeState({ ...s, ...remote }));
      });
    } catch {
      setCloudStatus("error");
    }
  }

  const timerMinutes = Math.floor(timer.remaining / 60);
  const timerSecs = timer.remaining % 60;
  const timerDisplay = `${String(timerMinutes).padStart(2, "0")}:${String(timerSecs).padStart(2, "0")}`;

  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterdayTasks = state.tasks.filter(x => x.date === dayKey(yesterdayDate));
  const yesterdayRate = yesterdayTasks.length
    ? Math.round((yesterdayTasks.filter(x => x.done).length / yesterdayTasks.length) * 100)
    : 0;
  const delta = rate - yesterdayRate;

  const hasAiKey = Boolean((import.meta.env.VITE_GEMINI_API_KEY || "").trim() || (import.meta.env.VITE_AI_API_URL || "").trim());

  return (
    <div className="app" dir={isAr ? "rtl" : "ltr"} lang={state.language}>
      <header className="topbar">
        <a className="brand" href="#">
          <span className="brand-mark">P</span>
          <span>Physics</span>
        </a>
        <div className="top-actions">
          <span className="date">{dateLabel(now, state.language)}</span>
          <button className="icon-button" onClick={() => setSettingsOpen(!settingsOpen)} aria-label={t.settings}>
            ⚙
          </button>
          <select aria-label={t.language} value={state.language} onChange={e => update({ language: e.target.value })}>
            <option value="en">EN</option>
            <option value="ar">عربي</option>
          </select>
        </div>
      </header>

      {settingsOpen && (
        <section className="settings-panel panel">
          <div className="section-head">
            <h3>{t.settings}</h3>
            <button className="text-button" onClick={() => setSettingsOpen(false)}>
              ×
            </button>
          </div>
          <label>
            {t.language}
            <select value={state.language} onChange={e => update({ language: e.target.value })}>
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
          </label>
          <label>
            {t.location}
            <input
              value={state.city}
              onChange={e => update({ city: e.target.value })}
              onBlur={loadPrayers}
              placeholder={t.cityHint}
            />
          </label>
          <button className="secondary-button" onClick={loadPrayers}>
            {t.save} · {t.prayer}
          </button>
          <button className="secondary-button" onClick={enableNotifications}>
            {t.notifications}
          </button>
          <button className="secondary-button" onClick={() => setKeepAwake(k => !k)}>
            {t.keepAwake}: {keepAwake ? t.keepAwakeOn : t.keepAwakeOff}
          </button>
          <div className="cloud-row">
            <span>{t.signInSync}</span>
            <span className="muted">{cloudStatus === "on" ? t.cloudOn : firebaseEnabled ? t.cloudOff : "Not configured"}</span>
          </div>
          <p className="tiny">{t.syncNote}</p>
          <button className="secondary-button" disabled={!firebaseEnabled || cloudStatus === "on"} onClick={connect}>
            {cloudStatus === "on" ? "Connected" : "Connect Firebase"}
          </button>
          <p className="tiny muted">{t.installHint}</p>
        </section>
      )}

      {!state.profile ? (
        <main className="onboarding">
          <div className="eyebrow">PHYSICS / PERSONAL SETUP</div>
          <h1>{t.onboarding}</h1>
          <p className="muted">
            {isAr
              ? "جاوب على كام سؤال بسيط عشان أرتب يوم يناسبك."
              : "A few quick answers help Physics shape a routine around your real day."}
          </p>
          <p className="tiny muted">{t.aiSetupStep}</p>
          <div className="panel onboarding-card">
            <label>
              {t.wake}
              <input type="time" value={onboard.wake} onChange={e => setOnboard({ ...onboard, wake: e.target.value })} />
            </label>
            <label>
              {t.sleep}
              <input type="time" value={onboard.sleep} onChange={e => setOnboard({ ...onboard, sleep: e.target.value })} />
            </label>
            <label>
              {t.peak}
              <select value={onboard.peak} onChange={e => setOnboard({ ...onboard, peak: e.target.value })}>
                <option value="Morning">{isAr ? "الصباح" : "Morning"}</option>
                <option value="Afternoon">{isAr ? "الظهيرة" : "Afternoon"}</option>
                <option value="Evening">{isAr ? "المساء" : "Evening"}</option>
                <option value="Flexible">{isAr ? "مرن" : "Flexible"}</option>
              </select>
            </label>
            <label>
              {t.priorities}
              <textarea
                rows="3"
                value={onboard.priorities}
                onChange={e => setOnboard({ ...onboard, priorities: e.target.value })}
                placeholder={t.priorityHint}
              />
            </label>
            <label>
              {t.style}
              <select value={onboard.style} onChange={e => setOnboard({ ...onboard, style: e.target.value })}>
                <option value="short">{t.short}</option>
                <option value="long">{t.long}</option>
              </select>
            </label>
            <button className="primary-button full" onClick={completeOnboarding}>
              {t.finish} <span>→</span>
            </button>
          </div>
        </main>
      ) : (
        <main className="main-grid">
          <section className="welcome">
            <div>
              <div className="eyebrow">{t.greeting.toUpperCase()}</div>
              <h1>{isAr ? "يومك، بشكل أوضح." : "A clearer day starts here."}</h1>
              <p>{state.profile?.aiSummary || t.subtitle}</p>
            </div>
            <div className="progress-card">
              <div className="progress-top">
                <span>{t.todayProgress}</span>
                <strong className="tabular">{rate}%</strong>
              </div>
              <div className="progress-track">
                <span style={{ width: `${rate}%` }} />
              </div>
              <small>
                {completed.length} / {tasksToday.length} {isAr ? "مهام" : "tasks"}
              </small>
            </div>
          </section>

          <section className="panel prayer-panel">
            <div className="panel-title">
              <div>
                <div className="eyebrow">{t.prayer.toUpperCase()}</div>
                <h2>{t.nextPrayer}</h2>
              </div>
              <span className="prayer-symbol">◷</span>
            </div>
            {nextPrayer ? (
              <div className="next-prayer">
                <strong>
                  {isAr
                    ? { Fajr: "الفجر", Dhuhr: "الظهر", Asr: "العصر", Maghrib: "المغرب", Isha: "العشاء" }[nextPrayer.name]
                    : nextPrayer.name}
                </strong>
                <span className="tabular">{formatTime(nextPrayer.at)}</span>
                <b className="tabular">{countdownText}</b>
              </div>
            ) : (
              <p className="muted">{prayerError || "—"}</p>
            )}
            <div className="prayer-list">
              {state.prayerTimes &&
                Object.entries(state.prayerTimes).map(([name, time]) => (
                  <div key={name}>
                    <span>
                      {isAr ? { Fajr: "الفجر", Dhuhr: "الظهر", Asr: "العصر", Maghrib: "المغرب", Isha: "العشاء" }[name] : name}
                    </span>
                    <b className="tabular">{time}</b>
                  </div>
                ))}
            </div>
            {prayerError && <p className="tiny warning">{prayerError}</p>}
          </section>

          <section className="panel tasks-panel">
            <div className="section-head">
              <div>
                <div className="eyebrow">{t.schedule.toUpperCase()}</div>
                <h2>{t.today}</h2>
              </div>
              <span className="count-pill">
                {pending.length} {t.remaining.toLowerCase()}
              </span>
            </div>
            <form
              className="add-task"
              onSubmit={e => {
                e.preventDefault();
                addTask();
              }}
            >
              <input value={taskText} onChange={e => setTaskText(e.target.value)} placeholder={t.taskPlaceholder} />
              <button className="primary-button">{t.add}</button>
            </form>
            <div className="task-columns">
              <div>
                <h3>
                  {t.remaining} <span>{pending.length}</span>
                </h3>
                {pending.length ? (
                  pending.map(x => <Task key={x.id} task={x} onToggle={toggleTask} onDelete={removeTask} t={t} />)
                ) : (
                  <p className="empty">{t.empty}</p>
                )}
              </div>
              <div>
                <h3>
                  {t.completed} <span>{completed.length}</span>
                </h3>
                {completed.length ? (
                  completed.map(x => <Task key={x.id} task={x} onToggle={toggleTask} onDelete={removeTask} t={t} />)
                ) : (
                  <p className="empty">{t.empty}</p>
                )}
              </div>
            </div>
          </section>

          <section className="panel timer-panel">
            <div className="eyebrow">{t.timer.toUpperCase()}</div>
            <h2 className="timer-number tabular">{timerDisplay}</h2>
            <div className="timer-controls">
              {!timer.running ? (
                <button
                  className="primary-button"
                  onClick={() => (timer.remaining === 0 ? startTimer(25) : setTimer(x => ({ ...x, running: true })))}
                >
                  {t.start}
                </button>
              ) : (
                <button className="primary-button" onClick={pauseTimer}>
                  {t.pause}
                </button>
              )}
              <button className="secondary-button" onClick={resetTimer}>
                {t.reset}
              </button>
            </div>
            <div className="presets">
              {state.timerPresets.map(n => (
                <button key={n} className="preset" onClick={() => startTimer(n)}>
                  {n}m
                </button>
              ))}
              <button className="preset" onClick={() => setCustomMinutesOpen(v => !v)}>
                +
              </button>
            </div>
            {customMinutesOpen && (
              <form
                className="custom-timer-form"
                onSubmit={e => {
                  e.preventDefault();
                  const mins = Number(customMinutesInput);
                  if (Number.isFinite(mins) && mins >= 1 && mins <= 240) {
                    startTimer(mins);
                  }
                }}
              >
                <input
                  type="number"
                  min="1"
                  max="240"
                  value={customMinutesInput}
                  onChange={e => setCustomMinutesInput(e.target.value)}
                  placeholder={t.customMinutesPlaceholder}
                />
                <button type="submit" className="secondary-button">
                  {t.ok}
                </button>
              </form>
            )}
            <p className="tiny muted">
              {t.focusTime}: <b>{focusToday} {t.minutes}</b>
            </p>
          </section>

          <section className="panel review-panel">
            <div className="eyebrow">{t.review.toUpperCase()}</div>
            <h2>{isAr ? "أداء النهارده" : "Your day, measured."}</h2>
            <div className="review-stats">
              <div>
                <strong className="tabular">{rate}%</strong>
                <span>{t.completed}</span>
              </div>
              <div>
                <strong className="tabular">{focusToday}</strong>
                <span>{t.focusTime}</span>
              </div>
              <div>
                <strong className="tabular">
                  {delta > 0 ? "+" : ""}
                  {delta}%
                </strong>
                <span>{isAr ? "مقارنة بمبارح" : "vs yesterday"}</span>
              </div>
            </div>
            <p className="muted small">
              {yesterdayTasks.length
                ? delta > 0
                  ? isAr
                    ? "إنجازك أعلى من امبارح. استمر على نفس الإيقاع."
                    : "You're ahead of yesterday. Keep the momentum."
                  : delta < 0
                    ? isAr
                      ? "إنجازك أقل من امبارح. اختار مهمة واحدة وابدأ بيها."
                      : "You're behind yesterday. Pick one task and restart with it."
                    : isAr
                      ? "نفس نسبة الإنجاز تقريباً."
                      : "Your completion rate is about the same."
                : isAr
                  ? "لسه مفيش بيانات من امبارح للمقارنة."
                  : "No task history from yesterday to compare yet."}
            </p>
            <button
              className="secondary-button"
              onClick={() => sendMessage(isAr ? "قارن إنجازي النهارده بمبارح" : "Compare my performance today with yesterday")}
            >
              {t.askReview}
            </button>
          </section>

          <section className="panel assistant-panel">
            <div className="section-head">
              <div>
                <div className="eyebrow">YOUR ASSISTANT</div>
                <h2>{t.ask}</h2>
              </div>
              <span className="assistant-dot" />
            </div>
            <div className="chat-log" aria-live="polite">
              {messages.length === 0 && (
                <p className="empty">
                  {isAr ? "اسألني إيه اللي فاضل، أو اطلب مني أشغل مؤقت." : "Ask what remains, request a daily review, or start a timer."}
                </p>
              )}
              {messages.map((m, i) => (
                <div key={i} className={`message ${m.role}`}>
                  {m.text}
                </div>
              ))}
              {busy && <div className="message assistant">…</div>}
            </div>
            <form
              className="chat-compose"
              onSubmit={e => {
                e.preventDefault();
                sendMessage();
              }}
            >
              <input value={chatInput} onChange={e => setChatInput(e.target.value)} placeholder={t.askPlaceholder} />
              <button
                type="button"
                className={`voice-button ${listening ? "active" : ""}`}
                onClick={beginVoice}
                aria-label={t.voice}
              >
                {listening ? "■" : "🎙"}
              </button>
              <button className="primary-button">{t.send}</button>
            </form>
            <div className="voice-actions">
              <button className="voice-link" onClick={beginVoice}>
                {listening ? t.stop : t.voice}
              </button>
              <button className="voice-link" onClick={armWakeWord}>
                {wakeArmed ? (isAr ? "إيقاف كلمة التنبيه" : "Disable wake phrase") : isAr ? "تفعيل كلمة فيزيكس" : "Enable wake phrase"}
              </button>
            </div>
            <p className="tiny muted">
              {!hasAiKey ? `${t.noAI} ` : ""}
              {isAr
                ? "كلمة التنبيه تعمل أثناء فتح التطبيق فقط، وقد يوقفها المتصفح أو النظام."
                : "Wake phrase listening works only while the app is open and may be stopped by the browser or operating system."}
            </p>
          </section>
        </main>
      )}
      <footer>
        <span>PHYSICS</span>
        <span>Local-first · Private by default</span>
      </footer>
    </div>
  );
}

function Task({ task, onToggle, onDelete, t }) {
  return (
    <div className={`task-row ${task.done ? "is-done" : ""}`}>
      <button className="check" onClick={() => onToggle(task.id)} aria-label={task.done ? t.pending : t.done}>
        {task.done ? "✓" : ""}
      </button>
      <span className="task-title">{task.title}</span>
      <button className="delete" onClick={() => onDelete(task.id)} aria-label={t.delete}>
        ×
      </button>
    </div>
  );
}
