let traditionalConverter;

function getTraditionalConverter() {
  if (!traditionalConverter) {
    // opencc-js bundles the OpenCC dictionaries, so the conversion stays local.
    const OpenCC = require("opencc-js");
    traditionalConverter = OpenCC.Converter({ from: "cn", to: "twp" });
  }
  return traditionalConverter;
}

function toTraditionalTaiwan(value, language = "zh-TW") {
  const text = String(value || "");
  if (!text || !String(language).toLowerCase().startsWith("zh-tw")) return text;
  try {
    return getTraditionalConverter()(text);
  } catch {
    // Keep the source text if a dictionary cannot be loaded; the caller can
    // surface the conversion warning without losing the transcript.
    return text;
  }
}

function normalizeNotes(note, language = "zh-TW") {
  if (!note || !String(language).toLowerCase().startsWith("zh-tw")) return note;
  const clone = JSON.parse(JSON.stringify(note));
  const fields = ["summary", "takeaway"];
  for (const key of fields) if (clone[key]) clone[key] = toTraditionalTaiwan(clone[key], language);
  for (const key of ["confusions", "reviewQuestions"]) {
    if (!Array.isArray(clone[key])) continue;
    clone[key] = clone[key].map((item) => typeof item === "string" ? toTraditionalTaiwan(item, language) : item);
  }
  if (Array.isArray(clone.sections)) clone.sections = clone.sections.map((section) => ({
    ...section,
    title: toTraditionalTaiwan(section.title, language),
    points: Array.isArray(section.points) ? section.points.map((point) => typeof point === "string"
      ? toTraditionalTaiwan(point, language)
      : { ...point, text: toTraditionalTaiwan(point.text, language), quote: toTraditionalTaiwan(point.quote, language) }) : [],
  }));
  return clone;
}

module.exports = { getTraditionalConverter, toTraditionalTaiwan, normalizeNotes };
