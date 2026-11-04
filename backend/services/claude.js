// Anthropic Claude: Hebrew post copy, analytics insights and reply suggestions.
// Without ANTHROPIC_API_KEY every function returns a clearly-marked demo result.
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config.js';
import { PRODUCTS, TONES } from '../constants.js';

let client = null;
export const claudeConfigured = () => !!env('ANTHROPIC_API_KEY');
const getClient = () => (client ??= new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') }));
const model = () => env('CLAUDE_MODEL', 'claude-opus-5-5');

const BRAND_SYSTEM = `אתה קופירייטר ואסטרטג סושיאל בכיר של המותג "בריא" – מותג פרימיום ישראלי למזון מסורתי ומזין:
ציר עצמות, ציר עוף, גהי (חמאה מזוקקת) וטאלו (שומן בקר).
קול המותג: חם, נקי, בטוח בעצמו, מבוסס ידע, בלי הגזמות. עברית טבעית ועכשווית, פנייה בגוף שני.
כללים מחייבים:
- אסור לטעון טענות רפואיות (ריפוי, מניעת מחלות, טיפול). מותר לדבר על מסורת, טעם, איכות חומרי גלם, שימושים במטבח ותחושת הזנה.
- אימוג'ים במידה (0–3 לפוסט).
- האשטגים בעברית ו/או באנגלית, ללא רווחים, עם #.`;

const POST_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'כותרת קצרה ומושכת בעברית' },
    body: { type: 'string', description: 'גוף הפוסט בעברית, 2–4 פסקאות קצרות' },
    cta: { type: 'string', description: 'קריאה לפעולה אחת בעברית' },
    hashtags: { type: 'array', items: { type: 'string' }, description: '5–8 האשטגים' },
    image_prompt: {
      type: 'string',
      description: 'English prompt for a photorealistic image generator. Premium wellness food photography, no text or logos in the image.',
    },
  },
  required: ['headline', 'body', 'cta', 'hashtags', 'image_prompt'],
  additionalProperties: false,
};

const INSIGHTS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'משפט סיכום אחד בעברית על מצב הביצועים' },
    bullets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'המלצה בכמה מילים' },
          detail: { type: 'string', description: 'הסבר קצר ומעשי מבוסס נתונים' },
        },
        required: ['title', 'detail'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'bullets'],
  additionalProperties: false,
};

const REPLY_SCHEMA = {
  type: 'object',
  properties: { reply: { type: 'string', description: 'תגובה קצרה וחמה בעברית בשם המותג' } },
  required: ['reply'],
  additionalProperties: false,
};

// One structured JSON call. Server-side refusal fallbacks are enabled; if the
// account/SDK rejects that beta, retry once as a plain request.
async function structured({ prompt, schema, effort = 'medium', maxTokens = 8000 }) {
  const base = {
    model: model(),
    max_tokens: maxTokens,
    system: BRAND_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort, format: { type: 'json_schema', schema } },
  };
  let res;
  try {
    res = await getClient().beta.messages.create({
      ...base,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } catch (err) {
    if (!(err instanceof Anthropic.BadRequestError)) throw err;
    res = await getClient().messages.create(base);
  }
  if (res.stop_reason === 'refusal') throw new Error('Claude סירב לבקשה. נסו לנסח אחרת.');
  if (res.stop_reason === 'max_tokens') throw new Error('התשובה של Claude נקטעה (max_tokens).');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

export async function generatePostCopy({ product, tone, notes }) {
  const p = PRODUCTS[product];
  const t = TONES[tone];
  if (!p || !t) throw new Error('מוצר או טון לא חוקיים');

  if (!claudeConfigured()) return { ...demoPost(product, tone), demo: true };

  const prompt = `כתוב פוסט אחד לפייסבוק ולאינסטגרם.
מוצר: ${p.he}
טון: ${t.he} – ${t.guide}
${notes ? `דגשים מהצוות: ${notes}` : ''}
ה-image_prompt באנגלית צריך לתאר צילום אוכל פרימיום של ${p.en}, אור טבעי רך, פלטת ירוקים-מרווה ולבן, רקע מטבח נקי, בלי טקסט בתמונה.`;
  return { ...(await structured({ prompt, schema: POST_SCHEMA })), demo: false };
}

export async function generateInsights(metricsRows) {
  if (!claudeConfigured()) return { ...demoInsights(), demo: true };
  const prompt = `להלן נתוני ביצועים של הפוסטים האחרונים של "בריא" (JSON). כל שורה: מוצר, טון, כותרת, תאריך פרסום, reach, likes, comments, shares, ושיעור מעורבות.
${JSON.stringify(metricsRows, null, 2)}

נתח את הנתונים והחזר 4–6 המלצות מעשיות בעברית: חידוד מסרים, אילו מוצרים/טונים עובדים, תזמון, פורמט, ו-CTA.
התבסס על הנתונים בפועל ואל תמציא מספרים.`;
  return { ...(await structured({ prompt, schema: INSIGHTS_SCHEMA, effort: 'high' })), demo: false };
}

export async function suggestReply({ comment, post }) {
  if (!claudeConfigured()) {
    return { reply: `תודה רבה ${comment.author || ''} 💚 שמחים שאת/ה איתנו! נשמח לעזור בכל שאלה – אפשר גם בהודעה פרטית.`.trim(), demo: true };
  }
  const prompt = `לקוח הגיב לפוסט של "בריא" ב-${comment.platform === 'instagram' ? 'אינסטגרם' : 'פייסבוק'}.
${post ? `כותרת הפוסט: ${post.headline}\nמוצר: ${PRODUCTS[post.product]?.he ?? ''}` : ''}
שם המגיב: ${comment.author}
התגובה: "${comment.message}"

נסח תגובה קצרה (1–3 משפטים), אישית וחמה. אם יש שאלה – ענה עליה בלי טענות רפואיות; אם צריך מידע אישי (הזמנה, משלוח) – הזמן להודעה פרטית.`;
  return { ...(await structured({ prompt, schema: REPLY_SCHEMA, effort: 'low', maxTokens: 2000 })), demo: false };
}

// ---------- demo content (used when no API key is configured) ----------

function demoPost(product, tone) {
  const he = PRODUCTS[product].he;
  const bodies = {
    educational: `ידעתם ש${he} הוא אחד המזונות המסורתיים הוותיקים במטבח?\n\nאצלנו ב"בריא" מכינים אותו לאט, מחומרי גלם נקיים ובלי קיצורי דרך – בדיוק כמו פעם.\n\nטיפ: התחילו את הבוקר עם כוס חמה, או השתמשו בו כבסיס לתבשיל הבא שלכם.`,
    sales: `${he} של "בריא" חזר למלאי – ובכמות מוגבלת.\n\nבישול איטי, חומרי גלם נבחרים, צנצנת זכוכית ששומרת על הטעם.\n\nזה הזמן למלא את המקרר לשבוע מזין.`,
    storytelling: `בוקר של שישי. הבית עוד שקט, ובמטבח כבר עולה ריח שמזכיר את הבית של סבתא.\n\nככה נולד ה${he} שלנו – מתוך רצון להחזיר לשולחן את הדברים הפשוטים והאמיתיים.\n\nכי אוכל טוב מתחיל בסבלנות.`,
  };
  return {
    headline: { educational: `מה שצריך לדעת על ${he}`, sales: `${he} טרי – רק השבוע`, storytelling: `הסיפור שמאחורי ה${he}` }[tone],
    body: bodies[tone],
    cta: tone === 'sales' ? 'להזמנה – קישור בביו 🌿' : 'ספרו לנו בתגובות איך אתם משתמשים בו 💚',
    hashtags: ['#בריא', `#${he.replace(/\s/g, '')}`, '#אוכלמסורתי', '#בישולאיטי', '#מזוןאמיתי', '#wellness'],
    image_prompt: `Premium food photography of ${PRODUCTS[product].en} on a light marble kitchen counter, soft natural morning light, sage green linen, fresh herbs, minimal and clean composition, shallow depth of field, no text`,
  };
}

function demoInsights() {
  return {
    summary: 'תובנות לדוגמה (מצב דמו) – חברו מפתח Claude כדי לקבל ניתוח אמיתי של הנתונים שלכם.',
    bullets: [
      { title: 'הטון הסיפורי מוביל במעורבות', detail: 'פוסטים סיפוריים מקבלים יותר תגובות ושיתופים – כדאי להפוך אותם לעוגן שבועי קבוע.' },
      { title: 'לחדד CTA בפוסטים מכירתיים', detail: 'הנעה כללית ("קישור בביו") חלשה יותר; נסו CTA ספציפי עם תועלת ותאריך.' },
      { title: 'גהי וטאלו – להסביר שימוש', detail: 'מוצרים פחות מוכרים זקוקים לתוכן חינוכי עם מתכון קצר לפני מכירה.' },
      { title: 'תזמון', detail: 'פרסום בבוקר (07:00–09:00) ובחמישי בערב מראה טווח הגעה גבוה יותר.' },
    ],
  };
}
