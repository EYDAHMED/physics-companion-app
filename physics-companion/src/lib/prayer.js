const PRAYERS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];
export async function fetchPrayerTimes(city, date = new Date(), method = 5) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth()+1).padStart(2, "0");
  const year = date.getFullYear();
  const url = `https://api.aladhan.com/v1/timingsByCity/${day}-${month}-${year}?city=${encodeURIComponent(city.split(",")[0])}&country=${encodeURIComponent(city.split(",").slice(1).join(",").trim() || "Egypt")}&method=${method}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("Prayer time service unavailable");
  const json = await response.json();
  if (json.code !== 200) throw new Error("Prayer time lookup failed");
  return Object.fromEntries(PRAYERS.map(name => [name, json.data.timings[name].slice(0,5)]));
}
export function getNextPrayer(times, now = new Date()) {
  if (!times) return null;
  for (const name of PRAYERS) {
    const [h,m] = times[name].split(":").map(Number);
    const at = new Date(now); at.setHours(h,m,0,0);
    if (at > now) return { name, at };
  }
  const [h,m] = times.Fajr.split(":").map(Number);
  const at = new Date(now); at.setDate(at.getDate()+1); at.setHours(h,m,0,0);
  return { name:"Fajr", at };
}
export function prayerDateTime(time, date = new Date()) {
  const [h,m] = time.split(":").map(Number);
  const d = new Date(date); d.setHours(h,m,0,0); return d;
}
