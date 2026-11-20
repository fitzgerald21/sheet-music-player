// Finding the drawing of each note in a rendered OSMD score, and writing note names next to them.
// Shared by the score view and the print view.
import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import type { NoteName } from '../model/noteNames';

/** The SVG group of every drawn note, by event id (`eventKeys` comes from toMusicXML). */
export function noteGroups(osmd: OpenSheetMusicDisplay, eventKeys: Map<string, string>): Map<string, SVGGElement[]> {
  const elems = new Map<string, SVGGElement[]>();
  const list = osmd.GraphicSheet?.MeasureList ?? [];
  list.forEach((staves, mi) => {
    staves.forEach((gm, si) => {
      if (!gm) return;
      const graceCount = new Map<number, number>();
      for (const se of gm.staffEntries) {
        for (const gve of se.graphicalVoiceEntries) {
          const ve = gve.parentVoiceEntry;
          const voiceId = ve.ParentVoice.VoiceId;
          const tick = Math.round(ve.Timestamp.RealValue * 384);
          let key = `${mi}|${si}|${voiceId}|${tick}`;
          if (ve.IsGrace) {
            const g = graceCount.get(voiceId) ?? 0;
            graceCount.set(voiceId, g + 1);
            key += `|g${g}`;
          }
          const id = eventKeys.get(key);
          if (!id) continue;
          for (const gn of gve.notes) {
            const g = (gn as unknown as { getSVGGElement?: () => SVGGElement }).getSVGGElement?.();
            if (!g) continue;
            const arr = elems.get(id) ?? [];
            if (!arr.includes(g)) arr.push(g);
            elems.set(id, arr);
          }
        }
      }
    });
  });
  return elems;
}

/** Noteheads in a VexFlow note group, ordered lowest pitch first. */
export function noteheads(g: SVGGElement): Element[] {
  const heads = [...g.querySelectorAll('.vf-notehead')];
  return heads.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
}

/**
 * Letter names next to notes, drawn into each note's own group so they zoom, highlight and take
 * taps along with it. Names drawn earlier under `root` are removed first.
 */
export function drawNoteNames(root: ParentNode, groups: Map<string, SVGGElement[]>, names: Map<string, NoteName[]>) {
  root.querySelectorAll('.smp-name').forEach((t) => t.remove());
  for (const [id, list] of names) {
    const g = groups.get(id)?.[0];
    if (!g) continue;
    const heads = noteheads(g) as SVGGraphicsElement[];
    // start right of the whole chord: a note a step away is drawn beside the stem, not in line
    const right = Math.max(...heads.map((h) => { const b = h.getBBox(); return b.x + b.width; }));
    let below = Infinity;
    for (const n of list) {
      const head = heads[n.rank];
      if (!head) continue;
      const b = head.getBBox();
      const size = b.height * 1.3;
      const x = right + b.height * 0.4;
      // names come lowest first; one a step above the last would overlap it, so lift it clear
      const y = Math.min(b.y + b.height / 2, below - size * 0.9);
      below = y;
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('class', 'smp-name');
      t.setAttribute('x', String(x));
      t.setAttribute('y', String(y));
      t.setAttribute('font-size', String(size));
      t.setAttribute('stroke-width', String(size * 0.22));
      t.textContent = n.text;
      g.appendChild(t);
    }
  }
}
