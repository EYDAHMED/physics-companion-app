export const PHYSICS_SYSTEM_PROMPT = `You are "Physics", a comprehensive personal assistant for daily life management, time tracking, prayer times, accountability, and smart behavioral/routine analysis.
Your style is practical, direct, clear, and concise—no unnecessary fluff. Act as a reliable personal companion that tracks the user's day step by step.

Core Operating Rules:
1. Language Control: Always respond strictly in the user's active selected language inside the app (app_language). Adapt all replies, onboarding questions, schedules, timers, and progress comparisons to that language.
2. Wake Word & Immediate Response: When the user calls you by name ("Physics" / "Hey Physics") or gives a direct command, respond immediately and clearly without long introductions.
3. One-Time Onboarding: If user_profile is empty, conduct concise onboarding to learn wake/sleep schedule, peak focus hours, core priorities, and study/work habits, then generate their structured profile and initial schedule.
4. Timers & Prayer Times: Support creating/starting timers for study and tasks, and respect daily prayer times when planning or suggesting tasks.
5. Daily Schedule & Performance Comparison: Track tasks split into Completed and Remaining. When asked for a review or what is left, summarize remaining items and compare today's performance against the previous day (better or worse, with a brief reason).
6. Dynamic Updates: When the user adds, modifies, or completes a task, return structured actions/updates so app state updates immediately.`;

const isArabic = lang => lang === "ar";

function normalizeAction(rawAction, tasks = []) {
  if (!rawAction || typeof rawAction !== "object") return null;
  if (rawAction.type === "timer") {
    const mins = Math.max(1, Math.min(240, Number(rawAction.minutes) || 25));
    return { type: "timer", minutes: mins };
  }
  if (rawAction.type === "add" && typeof rawAction.title === "string" && rawAction.title.trim()) {
    return { type: "add", title: rawAction.title.trim() };
  }
  if (rawAction.type === "complete") {
    if (typeof rawAction.id === "string" && rawAction.id.trim()) {
      const matchById = tasks.find(t => t.id === rawAction.id.trim());
      if (matchById) return { type: "complete", id: matchById.id };
    }
    if (typeof rawAction.title === "string" && rawAction.title.trim()) {
      const needle = rawAction.title.trim().toLowerCase();
      const matchByTitle = tasks.find(t => !t.done && t.title.toLowerCase().includes(needle));
      if (matchByTitle) return { type: "complete", id: matchByTitle.id };
    }
  }
  return null;
}

function parseStructuredReply(rawText, tasks = []) {
  if (!rawText || typeof rawText !== "string") {
    return { text: "No response returned.", action: null };
  }
  const trimmed = rawText.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && (typeof parsed.text === "string" || typeof parsed.reply === "string")) {
      return {
        text: (parsed.text || parsed.reply || "").trim(),
        action: normalizeAction(parsed.action, tasks)
      };
    }
  } catch {
    // Plain text fallback
  }
  return { text: trimmed, action: null };
}

async function callGemini(message, context, apiKey) {
  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const contextPayload = JSON.stringify({
    app_language: context.language || "en",
    user_profile: context.profile || null,
    today_schedule: context.tasks || [],
    prayer_times: context.prayerTimes || null,
    yesterday_summary: context.yesterdaySummary || { rate: 0, focusMinutes: 0 },
    focus_minutes_today: context.focusMinutes || 0
  });

  const promptText = `Context JSON:
${contextPayload}

User message:
${message}

Respond ONLY with valid JSON in this exact format:
{"text":"concise response in app_language","action":null}
Where "action" is either null or one of:
- {"type":"timer","minutes":25}
- {"type":"complete","id":"task-id"}
- {"type":"add","title":"task title"}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: PHYSICS_SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: promptText }] }],
      generationConfig: {
        temperature: 0.35,
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini request failed (${response.status})`);
  }
  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const combinedText = parts.map(p => p.text || "").join("\n").trim();
  return parseStructuredReply(combinedText, context.tasks || []);
}

export async function askPhysics(message, context) {
  const endpoint = (import.meta.env.VITE_AI_API_URL || "").trim();
  if (endpoint) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system: PHYSICS_SYSTEM_PROMPT,
        app_language: context.language,
        user_profile: context.profile,
        today_schedule: context.tasks,
        prayer_times: context.prayerTimes,
        yesterday_summary: context.yesterdaySummary,
        message
      })
    });
    if (!response.ok) throw new Error("AI service request failed");
    const data = await response.json();
    return {
      text: data.text || data.reply || "No response returned.",
      action: normalizeAction(data.action, context.tasks || [])
    };
  }

  const geminiKey = (import.meta.env.VITE_GEMINI_API_KEY || "").trim();
  if (geminiKey) {
    return callGemini(message, context, geminiKey);
  }

  return localAssistant(message, context);
}

export function buildAiProfileSummary(answers, language = "en") {
  const ar = isArabic(language);
  const priorities = Array.isArray(answers.priorities)
    ? answers.priorities
    : String(answers.priorities || "")
        .split(/[,،]/)
        .map(s => s.trim())
        .filter(Boolean);

  const focusMinutes = answers.style === "long" ? 50 : 25;
  const peakLabel = answers.peak || "Morning";
  const summary = ar
    ? `الاستيقاظ ${answers.wake} والنوم ${answers.sleep}، أعلى تركيز في فترة ${peakLabel}، جلسات ${focusMinutes} دقيقة، وأهم الأولويات: ${priorities.join("، ") || "تنظيم اليوم"}.`
    : `Wake ${answers.wake}, sleep ${answers.sleep}, peak focus ${peakLabel}, ${focusMinutes}m blocks, top priorities: ${priorities.join(", ") || "daily routine"}.`;

  return {
    ...answers,
    priorities,
    focusMinutes,
    aiSummary: summary,
    createdAt: new Date().toISOString()
  };
}

function localAssistant(message, c) {
  const ar = isArabic(c.language);
  const q = message.toLowerCase();
  const tasks = Array.isArray(c.tasks) ? c.tasks : [];
  const pending = tasks.filter(t => !t.done);
  const done = tasks.filter(t => t.done);
  const say = (en, arabic) => (ar ? arabic : en);

  if (/left|remaining|schedule|متبقي|باقي|جدول/.test(q)) {
    return {
      text: say(
        `You have ${pending.length} task(s) remaining: ${pending.map(t => t.title).join(", ") || "nothing pending"}. ${done.length} completed so far.`,
        `متبقي ${pending.length} مهمة: ${pending.map(t => t.title).join("، ") || "مفيش مهام متبقية"}. أنجزت ${done.length} حتى الآن.`
      ),
      action: null
    };
  }

  if (/compare|review|yesterday|مقارن|مبارح|امبارح|مراجعة/.test(q)) {
    const prev = c.yesterdaySummary || { rate: 0, focusMinutes: 0 };
    const rate = tasks.length ? Math.round((done.length / tasks.length) * 100) : 0;
    const delta = rate - (prev.rate || 0);
    const focusDelta = (c.focusMinutes || 0) - (prev.focusMinutes || 0);
    const reasonEn =
      delta > 0
        ? "higher task completion rate than yesterday."
        : delta < 0
          ? "lower task completion rate than yesterday."
          : focusDelta > 0
            ? "more focus minutes logged today."
            : "similar pace to yesterday.";
    const reasonAr =
      delta > 0
        ? "نسبة إنجاز المهام أعلى من امبارح."
        : delta < 0
          ? "نسبة إنجاز المهام أقل من امبارح."
          : focusDelta > 0
            ? "دقائق التركيز النهارده أعلى."
            : "نفس معدل الأداء تقريباً.";

    return {
      text: say(
        `Today's completion: ${rate}% (${done.length}/${tasks.length}). Yesterday: ${prev.rate || 0}%. ${delta > 0 ? "Better" : delta < 0 ? "Lower" : "The same"} by ${Math.abs(delta)} percentage points (${reasonEn}) Focus today: ${c.focusMinutes || 0}m vs yesterday: ${prev.focusMinutes || 0}m.`,
        `إنجاز النهارده: ${rate}% (${done.length}/${tasks.length}). امبارح: ${prev.rate || 0}%. ${delta > 0 ? "أحسن" : delta < 0 ? "أقل" : "نفس المستوى"} بفارق ${Math.abs(delta)} نقطة (${reasonAr}) وقت التركيز النهارده: ${c.focusMinutes || 0} د مقابل امبارح: ${prev.focusMinutes || 0} د.`
      ),
      action: null
    };
  }

  const start = q.match(/(?:start|set|ابدأ|شغل).*?(\d{1,3})\s*(?:min|minute|دقيق)/);
  if (start) {
    const mins = Math.max(1, Math.min(240, Number(start[1]) || 25));
    return {
      text: say(`Starting a ${mins}-minute timer.`, `هبدأ مؤقت ${mins} دقيقة.`),
      action: { type: "timer", minutes: mins }
    };
  }

  const mark = tasks.find(t => !t.done && t.title && q.includes(t.title.toLowerCase()) && /done|complete|خلص|تمت/.test(q));
  if (mark) {
    return {
      text: say(`Marked "${mark.title}" as completed.`, `تم تسجيل "${mark.title}" كمهمة مكتملة.`),
      action: { type: "complete", id: mark.id }
    };
  }

  const add = message.match(/(?:add task|ضيف مهمة|أضف مهمة)\s*[:\-]?\s*(.+)/i);
  if (add) {
    return {
      text: say(`Added "${add[1].trim()}".`, `ضفت "${add[1].trim()}".`),
      action: { type: "add", title: add[1].trim() }
    };
  }

  return {
    text: say(
      "I can check your remaining tasks, compare your daily progress, start a timer, or mark a task complete. Add VITE_GEMINI_API_KEY in .env for full AI responses.",
      "أقدر أقولك المهام المتبقية، أقارن إنجازك، أشغل مؤقت، أو أسجل مهمة كمكتملة. ضيف VITE_GEMINI_API_KEY في ملف .env لتفعيل ردود الذكاء الاصطناعي الكاملة."
    ),
    action: null
  };
}
