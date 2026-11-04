# בריא · מערכת שיווק ואוטומציה לסושיאל

מערכת מקומית אחת (Node.js + React + SQLite) לניהול השיווק של "בריא": יצירת פוסטים עם Claude, יצירת תמונות, לוח תוכן ופרסום אוטומטי לפייסבוק ולאינסטגרם, אנליטיקס עם תובנות AI, תיבת תגובות מאוחדת וניהול משימות.

**הדגמה באתר:** https://drorbenari1971.github.io/bari-system/

ההדגמה רצה כולה בדפדפן, בנתונים לדוגמה, ואין בה שרת או חיבור לשירותים חיצוניים. GitHub Pages מגיש קבצים סטטיים בלבד, ולכן המערכת המלאה רצה רק מקומית. כדי לעדכן את ההדגמה אחרי שינוי, מריצים בתיקיית `frontend`:

```bash
npm run deploy:pages
```

## התקנה והפעלה

| קובץ | מה הוא עושה |
|---|---|
| `setup.bat` | פעם אחת: מתקין Node.js LTS (דרך winget) אם חסר, יוצר `backend\.env`, מריץ `npm install` לשרת ולממשק, מקים את בסיס הנתונים ובונה את הממשק |
| `start.bat` | הפעלה בלחיצה אחת: מריץ את השרת ופותח את http://localhost:4000 |
| `dev.bat` | מצב פיתוח: שרת עם הפעלה מחדש אוטומטית + ממשק עם hot-reload ב-http://localhost:5173 |

המערכת עובדת מיד גם **בלי מפתחות API** (מצב דמו): טקסטים ותמונות לדוגמה, פרסום בסימולציה ונתוני דמו. אפשר למחוק את נתוני הדמו מהסרגל הצדדי ("נקה נתוני דמו").

**גישה:** למערכת אין התחברות, ולכן היא פתוחה רק מהמחשב שעליו היא רצה. מכשירים אחרים ברשת ואתרים אחרים בדפדפן נחסמים.

## חיבור שירותים (`backend\.env`)

| משתנה | שימוש |
|---|---|
| `ANTHROPIC_API_KEY` | Claude: כתיבת פוסטים בעברית, תובנות אופטימיזציה והצעות תגובה. ברירת המחדל היא המודל `claude-opus-5-5` (ניתן לשנות ב-`CLAUDE_MODEL`) |
| `OPENAI_API_KEY`, `IMAGE_MODEL` | יצירת תמונות (`gpt-image-1` או `dall-e-3`). התמונות נחתכות לפיד 1:1 (1080×1080) ולסטורי 9:16 (1080×1920) |
| `META_PAGE_ID`, `META_PAGE_ACCESS_TOKEN` | פרסום לעמוד הפייסבוק, משיכת מדדים ותגובות ומענה לתגובות |
| `META_IG_USER_ID` | חשבון האינסטגרם העסקי שמחובר לעמוד |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | **נדרש לאינסטגרם**: אינסטגרם מוריד תמונות רק מכתובת ציבורית. בזמן הפרסום התמונות עולות ל-Cloudinary כ-JPEG, והמערכת עצמה לא נחשפת לאינטרנט. הערכים נמצאים בלוח הבקרה של Cloudinary |
| `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` | Webhooks לתגובות בזמן אמת. לא בשימוש בהגדרה הרגילה, כי הם דורשים כתובת ציבורית למערכת, והמערכת עצמה אינה מוגנת בהתחברות. תגובות מגיעות בסנכרון השעתי או בלחיצה על "משוך תגובות חדשות" |

אחרי כל שינוי ב-`.env` צריך להפעיל מחדש את `start.bat`.

**הרשאות Meta שצריך לבקש לטוקן העמוד:** `pages_manage_posts`, `pages_read_engagement`, `pages_manage_engagement`, `pages_read_user_content`, `read_insights`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`.

## איך זה עובד

- **מחולל התוכן** בוחר מוצר וטון. Claude מחזיר JSON מובנה (כותרת, גוף, CTA, האשטגים ו-prompt לתמונה), והפוסט נשמר כטיוטה. אפשר לערוך אותו לפני האישור.
- **אישור ותזמון** מעביר את הפוסט לסטטוס `scheduled`. ‏cron מקומי (`node-cron`) בודק כל דקה ומפרסם דרך Graph API: פייסבוק (תמונה + טקסט), פיד אינסטגרם (1:1) וסטורי אינסטגרם (9:16). התוצאה נרשמת ביומן הפרסום של הפוסט.
- **סנכרון** רץ כל שעה, וגם בלחיצה על כפתור. הוא מושך מדדים (טווח הגעה, לייקים, תגובות ושיתופים) ותגובות. כל סנכרון נשמר כ-snapshot ב-`post_metrics`, כך שנשמרת היסטוריה.
- **תובנות AI** שולחות ל-Claude את מדדי 30 הפוסטים האחרונים ושומרות את ההמלצות בטבלת `insights`.
- **צריך שהשרת יפעל** כדי שהפרסום המתוזמן יקרה. אם המחשב היה כבוי בזמן שנקבע, הפוסט יפורסם מיד כשהשרת יעלה שוב.

## מבנה

```
bari-system/
├─ setup.bat · start.bat · dev.bat
├─ backend/                 Express API (port 4000)
│  ├─ server.js             נקודת כניסה + הגשת הממשק הבנוי
│  ├─ db.js                 סכמת SQLite (node:sqlite) – data/bari.db
│  ├─ scheduler.js          cron: פרסום מתוזמן + סנכרון Meta
│  ├─ seed.js · init-db.js  נתוני דמו והקמת בסיס הנתונים
│  ├─ routes/               posts · tasks · analytics · engagement · webhooks
│  ├─ services/             claude.js · images.js · meta.js
│  └─ data/                 bari.db + media/ (התמונות שנוצרו)
└─ frontend/                React + Vite + Tailwind + Recharts (RTL)
   └─ src/pages/            Dashboard · ContentGenerator · CalendarPage · Analytics · Engagement · Tasks
```

> הערה: התיקייה נמצאת ב-OneDrive, ולכן OneDrive יסנכרן גם את `node_modules` ואת בסיס הנתונים. אם הסנכרון מאט את העבודה, אפשר להעביר את התיקייה למיקום מחוץ ל-OneDrive (למשל `C:\bari-system`). כל הנתיבים במערכת יחסיים, כך שהיא תמשיך לעבוד גם במיקום החדש.
