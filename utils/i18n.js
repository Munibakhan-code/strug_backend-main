import i18next from "i18next";
import Backend from "i18next-fs-backend";
import middleware from "i18next-http-middleware";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await i18next
  .use(Backend)
  .use(middleware.LanguageDetector)
  .init({
    fallbackLng: "en",
    supportedLngs: [
      "af", "ar", "az", "bn", "bs", "bg", "ca", "cs", "da", "nl",
      "en", "et", "tl", "fi", "fr", "ka", "de", "el", "gu", "ha",
      "he", "hi", "hu", "is", "ga", "it", "ja", "kk", "ko", "lv",
      "ln", "lt", "lb", "mk", "ms", "zh", "ne", "no", "ps", "fa",
      "pl", "pt", "ro", "ru", "sr", "sk", "sl", "so", "es", "sw",
      "sv", "ta", "th", "tr", "ur", "vi", "cy",
    ],
    backend: {
      loadPath: path.join(__dirname, "../locales/{{lng}}/translation.json"),
    },
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ["header", "querystring"],
      lookupHeader: "accept-language",
      lookupQuerystring: "lng",
    },
  });

export default i18next;
