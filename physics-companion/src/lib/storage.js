const KEY = "physics-companion-v1";
export const emptyState = {
  language: "en",
  profile: null,
  tasks: [],
  timerPresets: [25, 45, 50],
  sessions: [],
  city: "Hurghada, Egypt",
  prayerMethod: 5,
  lastPrayerDate: "",
  prayerTimes: null,
  createdAt: new Date().toISOString()
};

export function sanitizeState(raw) {
  const base = { ...emptyState, ...(raw && typeof raw === "object" ? raw : {}) };
  base.language = base.language === "ar" ? "ar" : "en";
  base.tasks = Array.isArray(base.tasks)
    ? base.tasks.filter(t => t && typeof t.title === "string" && t.title.trim().length > 0)
    : [];
  base.sessions = Array.isArray(base.sessions)
    ? base.sessions.filter(s => s && typeof s.minutes === "number" && Number.isFinite(s.minutes) && s.minutes > 0)
    : [];
  base.timerPresets =
    Array.isArray(base.timerPresets) && base.timerPresets.length
      ? base.timerPresets.map(n => Number(n)).filter(n => Number.isFinite(n) && n > 0 && n <= 240)
      : [25, 45, 50];
  if (!base.timerPresets.length) base.timerPresets = [25, 45, 50];
  base.city = typeof base.city === "string" && base.city.trim() ? base.city.trim() : "Hurghada, Egypt";
  return base;
}

export function loadState() {
  try {
    return sanitizeState(JSON.parse(localStorage.getItem(KEY) || "{}"));
  } catch {
    return sanitizeState(emptyState);
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(sanitizeState(state)));
  } catch (err) {
    console.warn("Local storage save skipped:", err);
  }
}

export function dayKey(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
