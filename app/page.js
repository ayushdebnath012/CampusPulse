import { redirect } from "next/navigation";

export default function Home() {
  redirect("/index.html?v=6");
}
