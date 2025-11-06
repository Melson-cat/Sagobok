// src/lib/pdf.ts
export const mmToPt = (mm: number) => (mm / 25.4) * 72;

export function inferCoverSpec(productUid: string, pages: number) {
  // Enkel tumregel tills du byter mot exakta Gelato-specar per produkt
  const spineMm = Math.max(3, Math.round((pages || 30) * 0.09)); // ~0.09 mm/sida
  const trimMm = 200;
  const bleedMm = 3;
  const wrapMm = 17;

  const fullWmm = trimMm * 2 + spineMm + bleedMm * 2 + wrapMm * 2;
  const fullHmm = trimMm + bleedMm * 2 + wrapMm * 2;

  return {
    unit: "mm",
    fullWidth: fullWmm,
    fullHeight: fullHmm,
    spine: spineMm,
    trim: trimMm,
    bleed: bleedMm,
    wrap: wrapMm,
  };
}

export async function buildInteriorPDFStub(): Promise<ArrayBuffer> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 595]);
  page.drawText("BokPiloten – INTERIOR (stub)", { x: 40, y: 550, size: 18, font });
  const bytes = await pdf.save();
  return bytes.buffer;
}

export async function buildCoverPDFStub(coverSpec: {
  fullWidth: number; fullHeight: number; spine: number; trim: number; bleed: number; wrap: number;
}): Promise<ArrayBuffer> {
  const { PDFDocument, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const w = mmToPt(coverSpec.fullWidth);
  const h = mmToPt(coverSpec.fullHeight);
  const page = pdf.addPage([w, h]);
  page.drawRectangle({ x: 0, y: 0, width: w, height: h, color: rgb(0.98, 0.98, 0.98) });
  const bytes = await pdf.save();
  return bytes.buffer;
}
