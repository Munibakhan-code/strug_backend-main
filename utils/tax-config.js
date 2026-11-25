import dotenv from 'dotenv';
dotenv.config();

// Platform Fee එක .env ෆයිල් එකෙන් ගන්න (ප්‍රොඩක්ෂන් වලදී වෙනස් කරන්න පහසුයි)
export const PLATFORM_FEE_PERCENTAGE = parseFloat(process.env.PLATFORM_FEE || "0.08");

// සියලුම රටවල් සඳහා බදු සහ මුදල් ඒකක
export const REGIONAL_CONFIG = {
    // North America
    "United States": { tax: 0.0, currency: "USD" },
    "Canada": { tax: 0.13, currency: "CAD" },
    "Mexico": { tax: 0.16, currency: "MXN" },
    "Greenland": { tax: 0.0, currency: "DKK" },
    "Bermuda": { tax: 0.0, currency: "BMD" },

    // South America
    "Argentina": { tax: 0.21, currency: "ARS" },
    "Bolivia": { tax: 0.13, currency: "BOB" },
    "Brazil": { tax: 0.17, currency: "BRL" },
    "Chile": { tax: 0.19, currency: "CLP" },
    "Colombia": { tax: 0.19, currency: "COP" },
    "Ecuador": { tax: 0.12, currency: "USD" },
    "Paraguay": { tax: 0.10, currency: "PYG" },
    "Peru": { tax: 0.18, currency: "PEN" },
    "Uruguay": { tax: 0.22, currency: "UYU" },
    "Venezuela": { tax: 0.16, currency: "VES" },

    // Western Europe
    "United Kingdom": { tax: 0.20, currency: "GBP" },
    "Ireland": { tax: 0.23, currency: "EUR" },
    "France": { tax: 0.20, currency: "EUR" },
    "Germany": { tax: 0.19, currency: "EUR" },
    "Netherlands": { tax: 0.21, currency: "EUR" },
    "Belgium": { tax: 0.21, currency: "EUR" },
    "Luxembourg": { tax: 0.17, currency: "EUR" },
    "Austria": { tax: 0.20, currency: "EUR" },
    "Switzerland": { tax: 0.081, currency: "CHF" },
    "Monaco": { tax: 0.20, currency: "EUR" },

    // Northern Europe
    "Denmark": { tax: 0.25, currency: "DKK" },
    "Sweden": { tax: 0.25, currency: "SEK" },
    "Finland": { tax: 0.255, currency: "EUR" },
    "Norway": { tax: 0.25, currency: "NOK" },
    "Iceland": { tax: 0.24, currency: "ISK" },

    // Southern Europe
    "Spain": { tax: 0.21, currency: "EUR" },
    "Portugal": { tax: 0.23, currency: "EUR" },
    "Italy": { tax: 0.22, currency: "EUR" },
    "Greece": { tax: 0.24, currency: "EUR" },
    "Malta": { tax: 0.18, currency: "EUR" },
    "Cyprus": { tax: 0.19, currency: "EUR" },

    // Middle East
    "Israel": { tax: 0.18, currency: "ILS" },
    "Turkey": { tax: 0.20, currency: "TRY" },
    "Saudi Arabia": { tax: 0.15, currency: "SAR" },
    "United Arab Emirates": { tax: 0.05, currency: "AED" },
    "Qatar": { tax: 0.0, currency: "QAR" },
    "Kuwait": { tax: 0.0, currency: "KWD" },
    "Bahrain": { tax: 0.10, currency: "BHD" },
    "Oman": { tax: 0.05, currency: "OMR" },
    "Jordan": { tax: 0.16, currency: "JOD" },
    "Lebanon": { tax: 0.11, currency: "LBP" },

    // South Asia
    "India": { tax: 0.18, currency: "INR" },
    "Sri Lanka": { tax: 0.18, currency: "LKR" },
    "Bangladesh": { tax: 0.15, currency: "BDT" },
    "Nepal": { tax: 0.13, currency: "NPR" },
    "Bhutan": { tax: 0.0, currency: "BTN" },
    "Maldives": { tax: 0.06, currency: "MVR" },

    // Oceania
    "Australia": { tax: 0.10, currency: "AUD" },
    "New Zealand": { tax: 0.15, currency: "NZD" },
    "Fiji": { tax: 0.09, currency: "FJD" },
    "Papua New Guinea": { tax: 0.10, currency: "PGK" },
    "Samoa": { tax: 0.15, currency: "WST" },
    "Tonga": { tax: 0.15, currency: "TOP" },
    "Vanuatu": { tax: 0.15, currency: "VUV" },

    // Africa
    "South Africa": { tax: 0.15, currency: "ZAR" },
    "Egypt": { tax: 0.14, currency: "EGP" },
    "Morocco": { tax: 0.20, currency: "MAD" },
    "Kenya": { tax: 0.16, currency: "KES" },
    "Nigeria": { tax: 0.075, currency: "NGN" },
    "Ghana": { tax: 0.15, currency: "GHS" },
    "Tanzania": { tax: 0.18, currency: "TZS" },
    "Uganda": { tax: 0.18, currency: "UGX" },
    "Rwanda": { tax: 0.18, currency: "RWF" },
    "Ethiopia": { tax: 0.15, currency: "ETB" },

    // Default
    "default": { tax: 0.05, currency: "USD" }
};

export const getRegionData = (country) => {
    // Platform launches single-currency in CAD: keep per-country tax rates but
    // force the currency to CAD everywhere (Stripe settles in one currency).
    const base = REGIONAL_CONFIG[country] ?? REGIONAL_CONFIG["default"];
    return { ...base, currency: "CAD" };
};
