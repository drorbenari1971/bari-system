// Demo data so every screen is meaningful before API keys are connected.
// All rows are flagged is_demo=1 and can be removed from the UI ("נקה נתוני דמו").
import { db, insertMetric, upsertComment } from './db.js';
import { writePlaceholder } from './services/images.js';

const DAY = 86_400_000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

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

export function seedDemoIfEmpty() {
  const hasData = db.prepare('SELECT (SELECT COUNT(*) FROM posts) + (SELECT COUNT(*) FROM tasks) AS n').get().n > 0;
  if (hasData) return false;

  const insertPost = db.prepare(`
    INSERT INTO posts (product, tone, headline, body, cta, hashtags, image_prompt, status, published_at, fb_post_id, ig_media_id, is_demo, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, 1, ?)
  `);
  const postIds = [];
  DEMO_POSTS.forEach((p, i) => {
    const ageDays = (DEMO_POSTS.length - i) * 3.5;
    const published = iso(ageDays * DAY - 8 * 3_600_000);
    const { lastInsertRowid: id } = insertPost.run(
      p.product, p.tone, p.headline,
      'פוסט לדוגמה שנוצר אוטומטית כדי להציג את המערכת. חברו את Claude ו-Meta כדי לעבוד עם תוכן ונתונים אמיתיים.',
      'ספרו לנו בתגובות 💚', JSON.stringify(['#בריא', '#אוכלמסורתי', '#מזוןאמיתי']),
      'Premium wellness food photography, soft natural light', published, `demo_fb_${i}`, `demo_ig_${i}`, published,
    );
    postIds.push(id);
    db.prepare('UPDATE posts SET image_feed = ?, image_story = ? WHERE id = ?')
      .run(writePlaceholder(id, 'feed', p.product), writePlaceholder(id, 'story', p.product), id);

    // Three snapshots per platform to give the trend chart some history.
    for (const [platform, share] of [['facebook', 0.55], ['instagram', 0.45]]) {
      for (const [frac, hoursAfter] of [[0.45, 6], [0.8, 24], [1, 72]]) {
        insertMetric(id, platform, {
          reach: Math.round(p.reach * share * frac),
          likes: Math.round(p.likes * share * frac),
          comments: Math.round(p.comments * share * frac),
          shares: Math.round(p.shares * share * frac),
          captured_at: new Date(Date.parse(published) + hoursAfter * 3_600_000).toISOString(),
        });
      }
    }
  });

  DEMO_COMMENTS.forEach(([platform, author, message], i) => {
    upsertComment({
      external_id: `demo_c_${i}`, platform, author, message, is_demo: true,
      post_id: postIds[postIds.length - 1 - (i % postIds.length)],
      created_time: iso((i + 1) * 2.7 * 3_600_000),
    });
  });

  const insertTask = db.prepare('INSERT INTO tasks (title, description, status, priority, due_date, is_demo) VALUES (?, ?, ?, ?, ?, 1)');
  for (const [title, desc, status, priority, dueIn] of DEMO_TASKS) {
    insertTask.run(title, desc, status, priority, new Date(Date.now() + dueIn * DAY).toISOString().slice(0, 10));
  }
  return true;
}

export function clearDemoData() {
  const files = db.prepare('SELECT image_feed, image_story FROM posts WHERE is_demo = 1').all();
  db.exec(`
    DELETE FROM comments WHERE is_demo = 1;
    DELETE FROM posts WHERE is_demo = 1;
    DELETE FROM tasks WHERE is_demo = 1;
    DELETE FROM insights WHERE is_demo = 1;
  `);
  return files.flatMap((f) => [f.image_feed, f.image_story]).filter(Boolean);
}
