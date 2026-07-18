/**
 * Shared Tailwind arbitrary-variant typography styles for rendered markdown
 * (assistant messages, docs browser). Used with `dangerouslySetInnerHTML`.
 */
export const proseClasses =
  "[&_pre]:relative [&_pre]:my-3 [&_pre]:overflow-hidden [&_pre]:rounded-lg " +
  "[&_pre]:border [&_pre]:border-white/[0.06] [&_pre]:bg-[#0d0d0f] " +
  "[&_pre>code]:block [&_pre>code]:overflow-x-auto [&_pre>code]:p-4 [&_pre>code]:text-xs " +
  "[&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:ml-4 [&_li]:list-disc " +
  "[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold " +
  "[&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-base [&_h2]:font-semibold " +
  "[&_h3]:mt-2.5 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold " +
  "[&_:not(pre)>code]:text-signal [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.85em] " +
  "[&_a]:text-signal [&_a]:underline [&_a]:decoration-signal/30 " +
  "[&_a]:underline-offset-2 hover:[&_a]:decoration-signal/60 " +
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-signal/30 " +
  "[&_blockquote]:pl-3 [&_blockquote]:text-faint " +
  "[&_table]:my-2 [&_table]:w-full [&_table]:text-xs " +
  "[&_th]:border [&_th]:border-white/[0.06] [&_th]:px-2 [&_th]:py-1 " +
  "[&_th]:text-left [&_th]:font-medium " +
  "[&_td]:border [&_td]:border-white/[0.06] [&_td]:px-2 [&_td]:py-1 " +
  "[&_hr]:my-3 [&_hr]:border-t [&_hr]:border-white/[0.06]";
