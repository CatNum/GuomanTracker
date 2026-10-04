import type { Anime } from "./catalog.ts";

/** 退出成功才清理界面，SDK resolve 的 error 也属于失败。 */
export async function endCloudSession(
  auth: { signOut(): Promise<unknown> },
  clear: () => void,
) {
  const result = await auth.signOut();
  if (result && typeof result === "object" && "error" in result && result.error)
    throw new Error("微信退出未完成，请检查网络后重试。当前账号仍保留。");
  clear();
}

/** 日历新增节目通过补录路径登记；不信任前端传入的集数。 */
export async function followCatalogSeries<T>(
  series: Anime,
  known: Anime[],
  call: (action: string, payload: Record<string, unknown>) => Promise<T>,
) {
  return known.some((item) => item.id === series.id)
    ? call("follow", { seriesId: series.id })
    : call("submit", { title: series.title, url: series.url });
}
