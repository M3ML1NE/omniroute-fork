import { type NextRequest, NextResponse } from "next/server";
import { runAuthzPipeline } from "./server/authz/pipeline";

export async function middleware(request: NextRequest) {
  try {
    return await runAuthzPipeline(request);
  } catch (error) {
    console.error("[Middleware] Unhandled exception:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, sitemap.xml, robots.txt (metadata files)
     */
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};