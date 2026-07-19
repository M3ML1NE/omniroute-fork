// This API route is called automatically as a startup/health probe.
export async function GET() {
  return Response.json({ initialized: true });
}
