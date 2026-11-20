export function speak(text, language) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = language === "ar" ? "ar-EG" : "en-US";
  window.speechSynthesis.speak(utterance);
}
export function createRecognition(language, onText, onEnd, onError, continuous = false) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return null;
  const recognition = new Recognition();
  recognition.lang = language === "ar" ? "ar-EG" : "en-US";
  recognition.interimResults = false;
  recognition.continuous = continuous;
  recognition.onresult = e => { for (let i = e.resultIndex; i < e.results.length; i++) { if (e.results[i].isFinal) onText(e.results[i][0].transcript); } };
  recognition.onend = onEnd;
  recognition.onerror = onError;
  return recognition;
}
