/** The tabs of the machine page */
export type SectionId = 'dashboard' | 'report' | 'files' | 'tools' | 'settings';

/** The address keeps the open tab (for example /machine/m1?tab=report), so a reload or a link opens the same tab */
export const TAB_PARAM = 'tab';

/** The tab that opens when the address names no tab */
export const FIRST_TAB: SectionId = 'dashboard';

/** A link to a tab of the same machine, and to a section in it, for example `?tab=settings#settings-alert-rules` */
export function tabLink(tab: SectionId, sectionId?: string): string {
  return `?${TAB_PARAM}=${tab}${sectionId ? `#${sectionId}` : ''}`;
}

/** The tab that the address names, or the first tab */
export function tabInAddress(searchParams: URLSearchParams): string {
  return searchParams.get(TAB_PARAM) ?? FIRST_TAB;
}
