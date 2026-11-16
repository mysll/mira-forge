import { redirect } from "next/navigation";

export default function GalleryPage() {
  // 作品流已经合并进工作台首页，旧链接统一跳回去
  redirect("/");
}
