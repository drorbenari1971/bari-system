export const PRODUCTS = {
  bone_broth: { he: 'ציר עצמות', en: 'slow-simmered beef bone broth in a glass jar' },
  chicken_broth: { he: 'ציר עוף', en: 'golden chicken bone broth in a glass jar' },
  ghee: { he: 'גהי', en: 'golden clarified butter (ghee) in a glass jar' },
  tallow: { he: 'טאלו', en: 'pure grass-fed beef tallow in a glass jar' },
};

export const TONES = {
  educational: { he: 'חינוכי', guide: 'חינוכי ומעשיר: הסבר ערך תזונתי, מסורת, איך משתמשים, טיפ מעשי אחד. בלי לחץ מכירתי.' },
  sales: { he: 'מכירתי', guide: 'מכירתי וממוקד: יתרון ברור, סיבה לפעול עכשיו, הנעה חדה לפעולה – אבל אלגנטי, לא צעקני.' },
  storytelling: { he: 'סיפורי', guide: 'סיפורי ורגשי: פתיחה בסצנה מהחיים (מטבח, משפחה, בוקר), חיבור למסורת ולאיכות, סיום מחבר.' },
};

export const isRemoteId = (id) => !!id && !/^(demo_|sim_)/.test(id);
