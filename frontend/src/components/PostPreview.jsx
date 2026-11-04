import { ImageIcon, Leaf, ThumbsUp, MessageCircle, Share2 } from 'lucide-react';
import { productLabel, toneLabel } from '../constants.js';

// Side-by-side preview: post copy (as it will appear in the feed) + 1:1 feed image + 9:16 story.
export default function PostPreview({ post, editable = false, onChange, imageLoading = false }) {
  const set = (field) => (e) => onChange?.({ ...post, [field]: e.target.value });
  const hashtags = Array.isArray(post.hashtags) ? post.hashtags : [];

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      {/* Copy */}
      <div className="card overflow-hidden">
        <div className="flex items-center gap-3 border-b border-charcoal-100 px-4 py-3">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-sage-600 text-white"><Leaf className="h-4 w-4" /></span>
          <div className="text-sm">
            <div className="font-semibold">בריא</div>
            <div className="text-xs text-charcoal-400">{productLabel(post.product)} · {toneLabel(post.tone)}</div>
          </div>
        </div>
        <div className="space-y-3 p-4 text-[15px] leading-relaxed">
          {editable ? (
            <>
              <input className="input font-semibold" value={post.headline} onChange={set('headline')} placeholder="כותרת" />
              <textarea className="input min-h-[180px]" value={post.body} onChange={set('body')} placeholder="גוף הפוסט" />
              <input className="input" value={post.cta} onChange={set('cta')} placeholder="קריאה לפעולה" />
              <input
                className="input text-sage-700"
                value={hashtags.join(' ')}
                onChange={(e) => onChange?.({ ...post, hashtags: e.target.value.split(/\s+/).filter(Boolean) })}
                placeholder="#האשטגים"
              />
            </>
          ) : (
            <>
              <div className="text-lg font-semibold text-charcoal-900">{post.headline}</div>
              <div className="whitespace-pre-line text-charcoal-700">{post.body}</div>
              <div className="font-medium text-sage-700">{post.cta}</div>
              <div className="flex flex-wrap gap-x-2 text-sm text-sage-600">{hashtags.map((h) => <span key={h}>{h}</span>)}</div>
            </>
          )}
        </div>
        <div className="flex justify-around border-t border-charcoal-100 py-2.5 text-xs text-charcoal-400">
          <span className="flex items-center gap-1"><ThumbsUp className="h-3.5 w-3.5" /> אהבתי</span>
          <span className="flex items-center gap-1"><MessageCircle className="h-3.5 w-3.5" /> תגובה</span>
          <span className="flex items-center gap-1"><Share2 className="h-3.5 w-3.5" /> שיתוף</span>
        </div>
      </div>

      {/* Images */}
      <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] items-start gap-4">
        <figure>
          <figcaption className="mb-1.5 text-xs font-medium text-charcoal-500">פיד פייסבוק · 1:1</figcaption>
          <ImageSlot src={post.image_feed} ratio="aspect-square" loading={imageLoading} />
        </figure>
        <figure>
          <figcaption className="mb-1.5 text-xs font-medium text-charcoal-500">סטורי אינסטגרם · 9:16</figcaption>
          <div className="rounded-[1.6rem] border-[5px] border-[#2b2f2c] bg-[#2b2f2c] shadow-soft">
            <ImageSlot src={post.image_story} ratio="aspect-[9/16]" rounded="rounded-[1.25rem]" loading={imageLoading} />
          </div>
        </figure>
      </div>
    </div>
  );
}

function ImageSlot({ src, ratio, rounded = 'rounded-2xl', loading }) {
  if (loading) {
    return <div className={`${ratio} ${rounded} w-full animate-pulse bg-gradient-to-br from-sage-50 to-sage-200`} />;
  }
  if (!src) {
    return (
      <div className={`${ratio} ${rounded} grid w-full place-items-center border border-dashed border-sage-200 bg-sage-50/60 text-center text-xs text-sage-500`}>
        <div><ImageIcon className="mx-auto mb-1 h-6 w-6" />טרם נוצרה תמונה</div>
      </div>
    );
  }
  return <img src={src} alt="" className={`${ratio} ${rounded} w-full object-cover`} />;
}
