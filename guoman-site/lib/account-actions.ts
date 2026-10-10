import type { Anime } from "./catalog.ts";

/** A storage policy error must not keep account recovery loading forever. */
export function readDemoSelection(storage: Pick<Storage, "getItem">): { selected: boolean; error: string | null } {
  try { return { selected: storage.getItem("guoman-demo-enabled") === "yes", error: null }; }
  catch { return { selected: false, error: "浏览器存储不可用，无法恢复本机演示记录。" }; }
}

/** 退出成功才清理界面，SDK resolve 的 error 也属于失败。 */
export async function endCloudSession(
  auth: { signOut(): Promise<unknown> },
  clear: () => void,
) {
  const result = await auth.signOut();
  if (result && typeof result === "object" && "error" in result && result.error)
    throw new Error("账号退出未完成，请检查网络后重试。当前账号仍保留。");
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
