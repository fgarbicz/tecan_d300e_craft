// The guided tour used for the manual: one realistic experiment from the start screen to the Excel file.
// Each step: chapter, title, text (what the technician reads), target (CSS selector that is highlighted),
// and do(page) — the action that leads to the next step. record.mjs runs the list twice: once for
// screenshots (HTML demo + PDF), once for the video.

const fill = (sel, v) => async (page) => { await page.fill(sel, String(v)); await page.dispatchEvent(sel, 'input'); };
const click = (sel) => async (page) => { await page.click(sel); };
const choose = (sel, v) => async (page) => { await page.selectOption(sel, v); await page.dispatchEvent(sel, 'change'); };
const tab = (name) => click(`#opTabs [data-tab="${name}"]`);
const layer = (name) => click(`#layerSeg [data-layer="${name}"]`);

// simulated plate-reader values for plate 1: independent (Bliss) action of the two drugs with a little noise,
// read at the well the D300e really printed each dose into (the plate is randomized)
async function pasteSimulatedReadout(page) {
  const text = await page.evaluate(() => {
    const { S } = window.__d300;
    const p = S.protocol.plates[S.plateIdx];
    const root = (f) => (f.rootFluidId ?? f.id);
    const byName = Object.fromEntries(S.protocol.fluids.filter((f) => f.rootFluidId == null && !f.byVol).map((f) => [f.name, f.id]));
    const at = new Map((p.randomization || []).map((m) => [`${m.r},${m.c}`, [m.toR, m.toC]]));
    let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const vals = Array.from({ length: p.rows }, () => Array(p.cols).fill(null));
    const inner = (r, c) => r > 0 && c > 0 && r < p.rows - 1 && c < p.cols - 1;
    for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) vals[r][c] = inner(r, c) ? Math.round(100000 * (0.95 + 0.1 * rnd()) + 900) : Math.round(800 + 200 * rnd()); // untreated cells / PBS border
    for (const [k, m] of p.wells) {
      const dose = {};
      for (const [id, v] of m) { const f = S.protocol.fluids.find((x) => x.id === id); if (f && !f.byVol) dose[root(f)] = (dose[root(f)] || 0) + v; }
      const a = dose[byName.Bortezomib] || 0, b = dose[byName.Venetoclax] || 0;
      const via = 1 / (1 + (a / 0.004) ** 1.4), vib = 1 / (1 + (b / 0.6) ** 1.1);
      const [r, c] = at.get(k) || k.split(',').map(Number);
      vals[r][c] = Math.round(100000 * via * vib * (0.95 + 0.1 * rnd()) + 900);
    }
    return vals.map((row) => row.join('\t')).join('\n');
  });
  await page.fill('#rPaste', text);
}

export const STEPS = [
  // ---- start ----
  { chapter: 'Start', title: 'The start screen', target: '#start .cards',
    text: 'Craft opens on the start screen. A whole experiment — plates, drugs, doses, cell lines — is easiest with the wizard. "Open protocol" reads any .tdd file saved by D300e Control.' },
  { chapter: 'Start', title: 'How an experiment goes', target: '#start .flow',
    text: 'The five stages: design here, prepare the plates and tubes, print on the D300e, read the plates, then paste the values back here for viability and synergy.' },
  { chapter: 'Start', title: 'Start the wizard', target: '#stWizard', do: click('#stWizard'),
    text: 'Click "New experiment". This example: Bortezomib × Venetoclax on two myeloma cell lines, 384-well plates.' },

  // ---- wizard: plates ----
  { chapter: 'Wizard · 1 Plates', title: 'Plate and well volume', target: '#w_assay', do: fill('#w_assay', 50),
    text: 'Pick the plate type and the volume already in each well (medium + cells): 50 µL here. Doses are calculated against this volume.' },
  { chapter: 'Wizard · 1 Plates', title: 'DMSO limit', target: '#w_dmso',
    text: 'The most DMSO a well may receive, as % of the well volume. Craft warns you when a dose would need more.' },
  { chapter: 'Wizard · 1 Plates', title: 'Replicate plates', target: '#w_reps', do: fill('#w_reps', 2),
    text: 'How many identical plates to print of each layout: 2.' },
  { chapter: 'Wizard · 1 Plates', title: 'Priming wells and diluted stocks', target: '#w_dil',
    text: 'Keep these ticked. Very low doses then come from a second, diluted tube of the same drug (D300e "fluid shift / extend"), and tiny drops are primed in border wells first.' },
  { chapter: 'Wizard · 1 Plates', title: 'Your plate, drawn', target: '.wz-pic',
    text: 'The picture follows every change. Shaded wells are the PBS border: you fill them by hand, the D300e does not print there.' },
  { chapter: 'Wizard · 1 Plates', title: 'Next', target: '#wzNext', do: click('#wzNext'), text: 'Next: the drugs.' },

  // ---- wizard: drugs ----
  { chapter: 'Wizard · 2 Drugs', title: 'First drug and its stock', target: '[data-d="name"][data-i="0"]',
    do: async (page) => { await fill('[data-d="name"][data-i="0"]', 'Bortezomib')(page); await fill('[data-d="stock"][data-i="0"]', 10)(page); },
    text: 'Name each drug and the concentration of the tube you will pipette into the dispense head: Bortezomib, 10 mM in DMSO.' },
  { chapter: 'Wizard · 2 Drugs', title: 'Second drug', target: '[data-d="name"][data-i="1"]',
    do: async (page) => { await fill('[data-d="name"][data-i="1"]', 'Venetoclax')(page); await fill('[data-d="stock"][data-i="1"]', 10)(page); },
    text: 'Venetoclax, also 10 mM in DMSO. "Add drug" adds more; each extra drug can pair with the first one on its own set of plates.' },
  { chapter: 'Wizard · 2 Drugs', title: 'Next', target: '#wzNext', do: click('#wzNext'), text: 'Next: the doses and where they go.' },

  // ---- wizard: layout ----
  { chapter: 'Wizard · 3 Layout', title: 'Highest and lowest dose', target: '[data-a="high"][data-p="p"]',
    do: async (page) => { await fill('[data-a="high"][data-p="p"]', 10)(page); await fill('[data-a="low"][data-p="p"]', 0.0001)(page); await fill('[data-a="levels"][data-p="p"]', 10)(page); },
    text: 'Bortezomib runs across the columns. Type the highest dose (10 µM), the lowest (0.0001 µM = 0.1 nM) and the number of doses (10): the dilution step is calculated for you.' },
  { chapter: 'Wizard · 3 Layout', title: 'Units per drug', target: '[data-a="unit"][data-p="p"]', do: choose('[data-a="unit"][data-p="p"]', 'nM'),
    text: 'Prefer nanomolar for this drug? Change its unit: the doses are converted (10 µM becomes 10000 nM) and every table and map shows nM. The file for the D300e is unchanged.' },
  { chapter: 'Wizard · 3 Layout', title: 'Second drug down the rows', target: '[data-a="high"][data-p="0"]',
    do: async (page) => { await fill('[data-a="high"][data-p="0"]', 3)(page); await fill('[data-a="factor"][data-p="0"]', '1:2')(page); await fill('[data-a="levels"][data-p="0"]', 6)(page); await fill('[data-a="reps"][data-p="0"]', 1)(page); },
    text: 'Venetoclax runs down the rows: from 3 µM in 1:2 steps, 6 doses, one row each. "Add 0" adds the single-drug and vehicle-control wells.' },
  { chapter: 'Wizard · 3 Layout', title: 'Dose strip: which tube each dose comes from', target: '#lv_p',
    text: 'Each circle is one dose. Solid = from the stock; striped = from the diluted stock "Bortezomib - 1:30" that Craft added because 0.1 nM needs less than one drop of 10 mM.' },
  { chapter: 'Wizard · 3 Layout', title: 'What you will need', target: '#w_pic',
    text: 'The right side always shows plate 1 as it will look, how many plates to print, and which cassettes and dispense heads you need with which solution. If a layout does not fit, it says how many plates or heads it would take.' },
  { chapter: 'Wizard · 3 Layout', title: 'Next', target: '#wzNext', do: click('#wzNext'), text: 'Next: the cells.' },

  // ---- wizard: cell lines ----
  { chapter: 'Wizard · 4 Cell lines', title: 'Cell lines and arrangement', target: '#w_cells',
    do: async (page) => { await fill('#w_cells', 'MM.1S, KMS-11')(page); await choose('#w_cellMode', 'splitRows')(page); },
    text: 'Two cell lines, one in the top half and one in the bottom half of each plate. Cell lines are not sent to the D300e; they label every well in the results.' },
  { chapter: 'Wizard · 4 Cell lines', title: 'Randomize within each cell line', target: '#w_rand', do: async (page) => { await page.check('#w_rand'); await page.dispatchEvent('#w_rand', 'input'); },
    text: 'Tick to print the doses in a random order, against edge and gradient effects. A well only trades places with wells of the same cell line, so you still seed the cells as drawn.' },
  { chapter: 'Wizard · 4 Cell lines', title: 'Next', target: '#wzNext', do: click('#wzNext'), text: 'Next: review.' },

  // ---- wizard: review ----
  { chapter: 'Wizard · 5 Review', title: 'Review', target: '.wz-next',
    text: 'The review lists every plate and the bench steps that follow. Nothing is changed until you press Create.' },
  { chapter: 'Wizard · 5 Review', title: 'Create the plates', target: '#wzNext', do: click('#wzNext'),
    text: 'Create: the plates open in the editor. One Undo takes the whole wizard back.' },

  // ---- editor ----
  { chapter: 'Editor', title: 'The plate map', target: '.grid-wrap',
    text: 'Plate 1 as the D300e will print it. Colour = drug; a well with two drugs is split. The list on the left holds the drugs, cell lines and plates.' },
  { chapter: 'Editor', title: 'Randomized: as printed or as planned', target: '#randBar', do: click('#rvPlanned'),
    text: 'This plate is randomized. "As printed" shows where each dose really lands; "As planned" shows the tidy layout you designed (and is where you edit). "De-randomize" removes the shuffle.' },
  { chapter: 'Editor', title: 'Doses view', target: '#layerSeg [data-layer="doses"]', do: layer('doses'),
    text: 'In the planned view, "Doses" draws each drug as a gradient: pale = lowest, dark = highest. Easy to see that the series runs the right way.' },
  { chapter: 'Editor', title: 'Cell lines view', target: '#layerSeg [data-layer="cells"]', do: layer('cells'),
    text: '"Cell lines" shows where to seed which cells: MM.1S on top, KMS-11 below.' },
  { chapter: 'Editor', title: 'Any well, explained', target: '.well[data-r="3"][data-c="5"]',
    do: async (page) => { await layer('drugs')(page); await page.click('.well[data-r="3"][data-c="5"]'); },
    text: 'Click a well: the panel below the map lists its drugs, concentrations, DMSO and where it is printed.' },
  { chapter: 'Editor', title: 'Check', target: '#opTabs [data-tab="check"]', do: tab('check'),
    text: 'The Check tab lists anything the D300e would refuse or warn about — doses below one drop, too much DMSO, wells over the volume — in plain words with the wells to look at.' },

  // ---- run ----
  { chapter: 'Run plan', title: 'Run tab', target: '#opTabs [data-tab="run"]', do: tab('run'),
    text: 'Run: which cassettes you need and what to pipette into each dispense head.' },
  { chapter: 'Run plan', title: 'The cassette drawing', target: '#runDraw',
    text: 'Pipette the bold volume into each head, left to right. Each head shows the solution and its concentration; striped heads hold the diluted stock. Click to enlarge or save it for the bench.' },
  { chapter: 'Run plan', title: 'Save the protocol', target: '#btnSave', do: click('#btnSave'),
    text: 'Save writes the .tdd for D300e Control and an experiment file next to it (cell lines, units, results). Copy both to the D300e computer, open the .tdd there and press Run.' },

  // ---- results ----
  { chapter: 'Results', title: 'After the read-out', target: '#opTabs [data-tab="results"]', do: tab('results'),
    text: 'After incubation and the plate read (e.g. CellTiter-Glo), open the Results tab of the same file.' },
  { chapter: 'Results', title: 'Paste the plate reader values', target: '#rPaste', do: pasteSimulatedReadout,
    text: 'Copy the plate from the reader\'s Excel sheet and paste it here; row and column labels are fine. (This demo uses simulated values.)' },
  { chapter: 'Results', title: 'Read them in', target: '#rRead', do: click('#rRead'),
    text: '"Use for plate 1" matches every value to its well — on a randomized plate, to the well the dose was really printed in.' },
  { chapter: 'Results', title: 'Heat map and synergy', target: '#rSynergy',
    text: 'The map now shows the signal. Below: viability and Bliss synergy per cell line (red = the pair kills more than expected). The SynergyFinder package adds ZIP, HSA and Loewe in R.' },
  { chapter: 'Results', title: 'Excel', target: '#rExport',
    text: 'Export Excel: one row per well with cell line, every drug\'s concentration, DMSO, raw signal and % of vehicle, plus replicate statistics. That is the whole cycle.' },
];
