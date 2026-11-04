// In-browser stand-in for the Express API, used only by the GitHub Pages build
// (Pages serves static files, so there is no server, database or scheduler).
// Mirrors backend/routes/*, seed.js and the demo content in services/claude.js.
// All data lives in this visitor's localStorage; nothing leaves the browser.
const STORE_KEY = 'bari-demo-db-v1';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const nowIso = () => new Date().toISOString();
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

const PRODUCTS = {
  bone_broth: { he: 'ציר עצמות', en: 'slow-simmered beef bone broth in a glass jar' },
  chicken_broth: { he: 'ציר עוף', en: 'golden chicken bone broth in a glass jar' },
  ghee: { he: 'גהי', en: 'golden clarified butter (ghee) in a glass jar' },
  tallow: { he: 'טאלו', en: 'pure grass-fed beef tallow in a glass jar' },
};
const TONES = { educational: { he: 'חינוכי' }, sales: { he: 'מכירתי' }, storytelling: { he: 'סיפורי' } };

class ApiError extends Error {}
const fail = (message) => { throw new ApiError(message); };

// ---------- placeholder images ----------

function placeholder(kind, product, prompt = '') {
  const [width, height] = kind === 'feed' ? [1080, 1080] : [1080, 1920];
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const name = PRODUCTS[product]?.he ?? 'בריא';
  const cx = width / 2;
  const cy = height / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3f7f3"/><stop offset="1" stop-color="#c7dbc8"/></linearGradient>
  <linearGradient id="jar" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e9c46a"/><stop offset="1" stop-color="#c98f3a"/></linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <circle cx="${width * 0.85}" cy="${height * 0.12}" r="${width * 0.25}" fill="#a0c2a3" opacity="0.35"/>
  <circle cx="${width * 0.1}" cy="${height * 0.9}" r="${width * 0.3}" fill="#76a47b" opacity="0.2"/>
  <rect x="${cx - 150}" y="${cy - 190}" width="300" height="380" rx="48" fill="url(#jar)" opacity="0.92"/>
  <rect x="${cx - 162}" y="${cy - 240}" width="324" height="64" rx="16" fill="#37573b"/>
  <rect x="${cx - 120}" y="${cy - 60}" width="240" height="140" rx="12" fill="#fafaf7"/>
  <text x="${cx}" y="${cy + 5}" text-anchor="middle" font-family="Heebo, Arial" font-size="52" font-weight="700" fill="#2b2f2c" direction="rtl">בריא</text>
  <text x="${cx}" y="${cy + 55}" text-anchor="middle" font-family="Heebo, Arial" font-size="32" fill="#436c48" direction="rtl">${esc(name)}</text>
  <text x="${cx}" y="${height - 90}" text-anchor="middle" font-family="Heebo, Arial" font-size="30" fill="#37573b" direction="rtl">תמונת דמו · ${kind === 'feed' ? 'פיד 1:1' : 'סטורי 9:16'}</text>
  <text x="${cx}" y="${height - 45}" text-anchor="middle" font-family="Arial" font-size="20" fill="#56875c">${esc(prompt.slice(0, 80))}${prompt.length > 80 ? '…' : ''}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ---------- seed data ----------

const DEMO_POSTS = [
  { product: 'bone_broth', tone: 'storytelling', headline: 'הסיפור שמאחורי הציר של יום שישי', reach: 4820, likes: 412, comments: 58, shares: 37 },
  { product: 'ghee', tone: 'educational', headline: 'גהי: מה זה בעצם ואיך מבשלים איתו?', reach: 3610, likes: 255, comments: 41, shares: 22 },
  { product: 'chicken_broth', tone: 'sales', headline: 'ציר עוף טרי – רק השבוע במלאי', reach: 2950, likes: 178, comments: 19, shares: 8 },
  { product: 'tallow', tone: 'educational', headline: 'טאלו – השומן המסורתי שחוזר למטבח', reach: 2240, likes: 141, comments: 33, shares: 12 },
  { product: 'bone_broth', tone: 'sales', headline: 'מארז ציר עצמות לחורף', reach: 3380, likes: 201, comments: 24, shares: 15 },
  { product: 'ghee', tone: 'storytelling', headline: 'הבוקר שבו התאהבנו בגהי', reach: 4105, likes: 366, comments: 52, shares: 29 },
];
const DEMO_COMMENTS = [
  ['instagram', 'noa.cooks', 'אפשר להקפיא את הציר? כמה זמן הוא מחזיק במקרר?'],
  ['facebook', 'דנה לוי', 'הזמנתי בשבוע שעבר – פשוט מעולה! הילדים שותים כמו מרק 😍'],
  ['instagram', 'yoni_fit', 'יש משלוחים לצפון?'],
  ['facebook', 'מיכל אברהם', 'במה הגהי שונה מחמאה רגילה?'],
  ['instagram', 'healthy.shir', 'איזה צילום יפה 🌿'],
  ['facebook', 'רועי כהן', 'מתי ציר העוף חוזר למלאי?'],
  ['instagram', 'tal.kitchen', 'מטגנת רק בטאלו כבר חצי שנה, לא חוזרת אחורה'],
  ['facebook', 'אורית שמעוני', 'יש לכם נקודות איסוף בתל אביב?'],
];
const DEMO_TASKS = [
  ['לצלם סט תמונות חדש לגהי', 'צילום מוצר על רקע מטבח בהיר, 10 פריימים', 'in_progress', 'high', 2],
  ['לכתוב סדרת פוסטים חינוכיים על טאלו', '3 פוסטים: מה זה, איך משתמשים, מתכון', 'todo', 'medium', 5],
  ['לענות לכל התגובות הפתוחות', 'מעבר יומי על תיבת התגובות', 'todo', 'high', 0],
  ['להגדיר Meta Business Suite + הרשאות API', 'Page token ארוך טווח + IG Business ID', 'todo', 'medium', 7],
  ['קמפיין חורף – מארז צירים', 'בריף, תקציב ולו"ז', 'done', 'medium', -3],
];

function seed() {
  const db = { nextId: 1, posts: [], tasks: [], comments: [], insights: [] };
  const id = () => db.nextId++;
  DEMO_POSTS.forEach((p, i) => {
    const published = iso((DEMO_POSTS.length - i) * 3.5 * DAY - 8 * HOUR);
    db.posts.push({
      id: id(), product: p.product, tone: p.tone, headline: p.headline,
      body: 'פוסט לדוגמה שנוצר אוטומטית כדי להציג את המערכת.',
      cta: 'ספרו לנו בתגובות 💚', hashtags: ['#בריא', '#אוכלמסורתי', '#מזוןאמיתי'],
      image_prompt: 'Premium wellness food photography, soft natural light',
      image_feed: placeholder('feed', p.product), image_story: placeholder('story', p.product),
      status: 'published', platforms: ['facebook', 'instagram'], scheduled_at: null, published_at: published,
      publish_log: [], is_demo: true, created_at: published,
      metrics: { reach: p.reach, likes: p.likes, comments: p.comments, shares: p.shares },
    });
  });
  const postIds = db.posts.map((p) => p.id);
  DEMO_COMMENTS.forEach(([platform, author, message], i) => {
    db.comments.push({
      id: id(), platform, author, message, post_id: postIds[postIds.length - 1 - (i % postIds.length)],
      created_time: iso((i + 1) * 2.7 * HOUR), is_read: false, replied: false, is_demo: true, replies: [],
    });
  });
  DEMO_TASKS.forEach(([title, description, status, priority, dueIn]) => {
    db.tasks.push({
      id: id(), title, description, status, priority, is_demo: 1,
      due_date: new Date(Date.now() + dueIn * DAY).toISOString().slice(0, 10), created_at: nowIso(),
    });
  });
  return db;
}

// ---------- persistence ----------

let memory = null;
function load() {
  if (memory) return memory;
  try { memory = JSON.parse(localStorage.getItem(STORE_KEY)); } catch { memory = null; }
  if (!memory) { memory = seed(); save(); }
  return memory;
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(memory)); } catch { /* keep working from memory */ }
}

// ---------- demo content (same text as backend/services/claude.js) ----------

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
const DEMO_INSIGHTS = {
  summary: 'תובנות לדוגמה (הדגמה בדפדפן) – בגרסה המלאה Claude מנתח את הנתונים האמיתיים שלכם.',
  bullets: [
    { title: 'הטון הסיפורי מוביל במעורבות', detail: 'פוסטים סיפוריים מקבלים יותר תגובות ושיתופים – כדאי להפוך אותם לעוגן שבועי קבוע.' },
    { title: 'לחדד CTA בפוסטים מכירתיים', detail: 'הנעה כללית ("קישור בביו") חלשה יותר; נסו CTA ספציפי עם תועלת ותאריך.' },
    { title: 'גהי וטאלו – להסביר שימוש', detail: 'מוצרים פחות מוכרים זקוקים לתוכן חינוכי עם מתכון קצר לפני מכירה.' },
    { title: 'תזמון', detail: 'פרסום בבוקר (07:00–09:00) ובחמישי בערב מראה טווח הגעה גבוה יותר.' },
  ],
};

// ---------- helpers ----------

const getPost = (db, id) => db.posts.find((p) => p.id === Number(id)) ?? fail('פוסט לא נמצא');
const stamp = () => new Date().toLocaleString('he-IL');
const sortDate = (p) => p.scheduled_at ?? p.published_at ?? p.created_at;

function simulatePublish(post) {
  if (['published', 'publishing'].includes(post.status)) fail('הפוסט כבר מפורסם או בתהליך פרסום');
  post.status = 'published';
  post.published_at = nowIso();
  post.publish_log = [...post.publish_log, `[${stamp()}] סימולציה: גרסת הדגמה בדפדפן – שום דבר לא פורסם בפועל.`];
}

function runDuePosts(db) {
  const now = nowIso();
  db.posts.filter((p) => p.status === 'scheduled' && p.scheduled_at <= now).forEach(simulatePublish);
}

function performance(db) {
  return db.posts
    .filter((p) => p.status === 'published')
    .sort((a, b) => (a.published_at < b.published_at ? -1 : 1))
    .map((p) => {
      const m = p.metrics ?? { reach: 0, likes: 0, comments: 0, shares: 0 };
      return {
        id: p.id, headline: p.headline, product: p.product, tone: p.tone, published_at: p.published_at,
        image_feed: p.image_feed, is_demo: p.is_demo, ...m,
        engagement_rate: m.reach ? +((m.likes + m.comments + m.shares) / m.reach * 100).toFixed(2) : 0,
        byPlatform: {},
      };
    });
}
const sumTotals = (rows) => rows.reduce((t, p) => ({
  reach: t.reach + p.reach, likes: t.likes + p.likes, comments: t.comments + p.comments, shares: t.shares + p.shares,
}), { reach: 0, likes: 0, comments: 0, shares: 0 });

const withPostInfo = (db, c) => {
  const post = db.posts.find((p) => p.id === c.post_id);
  return { ...c, post_headline: post?.headline ?? null, post_product: post?.product ?? null };
};
const newestComments = (db) => [...db.comments].sort((a, b) => (a.created_time < b.created_time ? 1 : -1));
const priorityRank = { high: 0, medium: 1, low: 2 };
const statusRank = { in_progress: 0, todo: 1, done: 2 };

// ---------- routes ----------

const SYNC_SKIPPED = { skipped: true, reason: 'גרסת הדגמה בדפדפן – אין חיבור ל-Meta', metrics: 0, newComments: 0 };

const routes = [
  ['GET', /^\/status$/, (db) => ({
    claude: false, images: false, facebook: false, instagram: false, imageHosting: false,
    model: 'claude-opus-5-5',
    hasDemoData: db.posts.some((p) => p.is_demo) || db.tasks.some((t) => t.is_demo),
  })],
  ['GET', /^\/dashboard$/, (db) => {
    const perf = performance(db);
    const posts = (status) => db.posts.filter((p) => p.status === status);
    return {
      totals: sumTotals(perf),
      counts: {
        drafts: posts('draft').length, scheduled: posts('scheduled').length, published: perf.length,
        unanswered: db.comments.filter((c) => !c.replied).length,
      },
      tasks: db.tasks.filter((t) => t.status !== 'done')
        .sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'))
        .slice(0, 8),
      upcoming: posts('scheduled').sort((a, b) => (a.scheduled_at < b.scheduled_at ? -1 : 1)).slice(0, 5),
      recentComments: newestComments(db).slice(0, 10).map((c) => withPostInfo(db, c)),
      topPosts: [...perf].sort((a, b) => b.reach - a.reach).slice(0, 3),
    };
  }],
  ['POST', /^\/demo\/clear$/, (db) => {
    const removed = new Set(db.posts.filter((p) => p.is_demo).map((p) => p.id));
    db.posts = db.posts.filter((p) => !p.is_demo);
    db.tasks = db.tasks.filter((t) => !t.is_demo);
    db.comments = db.comments.filter((c) => !c.is_demo && !removed.has(c.post_id));
    db.insights = db.insights.filter((i) => !i.is_demo);
    return { ok: true };
  }],

  // posts
  ['GET', /^\/posts$/, (db, _m, _b, q) => {
    const statuses = q.get('status')?.split(',');
    const from = q.get('from');
    const to = q.get('to');
    return db.posts
      .filter((p) => (!statuses || statuses.includes(p.status)) && (!from || sortDate(p) >= from) && (!to || sortDate(p) < to))
      .sort((a, b) => (sortDate(a) < sortDate(b) ? 1 : -1));
  }],
  ['POST', /^\/posts\/generate$/, (db, _m, { product, tone }) => {
    if (!PRODUCTS[product] || !TONES[tone]) fail('יש לבחור מוצר וטון');
    const post = {
      id: db.nextId++, product, tone, ...demoPost(product, tone), image_feed: null, image_story: null,
      status: 'draft', platforms: ['facebook', 'instagram'], scheduled_at: null, published_at: null,
      publish_log: [], is_demo: false, created_at: nowIso(),
    };
    db.posts.push(post);
    return { post, demo: false }; // the page-wide banner already explains the demo; no API-key hints here
  }],
  ['GET', /^\/posts\/(\d+)$/, (db, [, id]) => getPost(db, id)],
  ['POST', /^\/posts\/(\d+)\/images$/, (db, [, id], body) => {
    const post = getPost(db, id);
    const prompt = (body.image_prompt ?? post.image_prompt).trim();
    if (!prompt) fail('חסר תיאור תמונה');
    Object.assign(post, { image_prompt: prompt, image_feed: placeholder('feed', post.product, prompt), image_story: placeholder('story', post.product, prompt) });
    return { post, demo: false }; // the page-wide banner already explains the demo; no API-key hints here
  }],
  ['PUT', /^\/posts\/(\d+)$/, (db, [, id], body) => {
    const post = getPost(db, id);
    for (const k of ['headline', 'body', 'cta', 'hashtags', 'image_prompt', 'platforms']) if (k in body) post[k] = body[k];
    return post;
  }],
  ['POST', /^\/posts\/(\d+)\/schedule$/, (db, [, id], body) => {
    const post = getPost(db, id);
    if (['published', 'publishing'].includes(post.status)) fail('הפוסט כבר פורסם');
    const when = new Date(body.scheduled_at);
    if (Number.isNaN(when.getTime())) fail('תאריך לא תקין');
    if (when.getTime() < Date.now() - 60_000) fail('לא ניתן לתזמן לעבר');
    if (body.platforms?.length) post.platforms = body.platforms;
    post.status = 'scheduled';
    post.scheduled_at = when.toISOString();
    return post;
  }],
  ['POST', /^\/posts\/(\d+)\/unschedule$/, (db, [, id]) => {
    const post = getPost(db, id);
    if (post.status !== 'scheduled') fail('הפוסט אינו מתוזמן');
    post.status = 'draft';
    post.scheduled_at = null;
    return post;
  }],
  ['POST', /^\/posts\/(\d+)\/publish-now$/, (db, [, id]) => {
    const post = getPost(db, id);
    simulatePublish(post);
    return post;
  }],
  ['POST', /^\/posts\/(\d+)\/duplicate$/, (db, [, id]) => {
    const p = getPost(db, id);
    const copy = {
      ...p, id: db.nextId++, image_feed: null, image_story: null, status: 'draft', scheduled_at: null, published_at: null,
      publish_log: [], is_demo: false, created_at: nowIso(), metrics: undefined,
    };
    db.posts.push(copy);
    return copy;
  }],
  ['DELETE', /^\/posts\/(\d+)$/, (db, [, id]) => {
    getPost(db, id);
    db.posts = db.posts.filter((p) => p.id !== Number(id));
    db.comments.forEach((c) => { if (c.post_id === Number(id)) c.post_id = null; });
    return { ok: true };
  }],

  // tasks
  ['GET', /^\/tasks$/, (db) => [...db.tasks].sort((a, b) =>
    statusRank[a.status] - statusRank[b.status] || priorityRank[a.priority] - priorityRank[b.priority]
    || (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || b.id - a.id)],
  ['POST', /^\/tasks$/, (db, _m, { title, description = '', priority = 'medium', due_date = null, status = 'todo' }) => {
    if (!title?.trim()) fail('נדרשת כותרת למשימה');
    const task = { id: db.nextId++, title: title.trim(), description, status, priority, due_date: due_date || null, is_demo: 0, created_at: nowIso() };
    db.tasks.push(task);
    return task;
  }],
  ['PUT', /^\/tasks\/(\d+)$/, (db, [, id], body) => {
    const task = db.tasks.find((t) => t.id === Number(id)) ?? fail('משימה לא נמצאה');
    return Object.assign(task, body);
  }],
  ['DELETE', /^\/tasks\/(\d+)$/, (db, [, id]) => {
    db.tasks = db.tasks.filter((t) => t.id !== Number(id));
    return { ok: true };
  }],

  // analytics
  ['GET', /^\/analytics\/summary$/, (db) => {
    const posts = performance(db);
    const group = (key, labels) => Object.entries(labels).map(([id, l]) => {
      const subset = posts.filter((p) => p[key] === id);
      const reach = subset.reduce((s, p) => s + p.reach, 0);
      const engagement = subset.reduce((s, p) => s + p.likes + p.comments + p.shares, 0);
      return { id, label: l.he, posts: subset.length, reach, engagement, engagement_rate: reach ? +(engagement / reach * 100).toFixed(2) : 0 };
    });
    return { totals: sumTotals(posts), posts, byProduct: group('product', PRODUCTS), byTone: group('tone', TONES) };
  }],
  ['POST', /^\/analytics\/sync$/, () => SYNC_SKIPPED],
  ['GET', /^\/analytics\/insights\/latest$/, (db) => db.insights[db.insights.length - 1] ?? null],
  ['POST', /^\/analytics\/insights$/, (db) => {
    if (!performance(db).length) fail('אין עדיין פוסטים שפורסמו לניתוח');
    const row = { id: db.nextId++, ...DEMO_INSIGHTS, is_demo: true, created_at: nowIso() };
    db.insights.push(row);
    return row;
  }],

  // engagement
  ['GET', /^\/engagement\/comments$/, (db, _m, _b, q) => newestComments(db)
    .filter((c) => (!q.get('platform') || c.platform === q.get('platform'))
      && (q.get('filter') !== 'unanswered' || !c.replied)
      && (q.get('filter') !== 'unread' || !c.is_read))
    .map((c) => withPostInfo(db, c))],
  ['POST', /^\/engagement\/sync$/, () => SYNC_SKIPPED],
  ['POST', /^\/engagement\/comments\/(\d+)\/read$/, (db, [, id]) => {
    const c = db.comments.find((x) => x.id === Number(id));
    if (c) c.is_read = true;
    return { ok: true };
  }],
  ['POST', /^\/engagement\/comments\/(\d+)\/suggest$/, (db, [, id]) => {
    const c = db.comments.find((x) => x.id === Number(id)) ?? fail('תגובה לא נמצאה');
    return { reply: `תודה רבה ${c.author} 💚 שמחים שאת/ה איתנו! נשמח לעזור בכל שאלה – אפשר גם בהודעה פרטית.`, demo: true };
  }],
  ['POST', /^\/engagement\/comments\/(\d+)\/reply$/, (db, [, id], body) => {
    const c = db.comments.find((x) => x.id === Number(id)) ?? fail('תגובה לא נמצאה');
    const message = String(body.message ?? '').trim();
    if (!message) fail('אין טקסט לתגובה');
    c.replies = [...c.replies, { id: db.nextId++, message, status: 'simulated', error: null, created_at: nowIso() }];
    c.replied = true;
    c.is_read = true;
    return { ok: true, status: 'simulated' };
  }],
];

export async function mockRequest(method, url, body = {}) {
  const parsed = new URL(url, 'http://demo.local');
  const db = load();
  runDuePosts(db);
  for (const [m, pattern, handler] of routes) {
    const match = m === method && parsed.pathname.match(pattern);
    if (match) {
      const result = handler(db, match, body, parsed.searchParams);
      save();
      return JSON.parse(JSON.stringify(result ?? null)); // same isolation as a real response
    }
  }
  throw new ApiError('נתיב API לא קיים');
}
