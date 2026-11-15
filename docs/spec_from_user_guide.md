# D300e protocol designer: behaviour specification from the user guide

Source: *D300e Dispensing Software User Guide*, HP document 64A009000de780105924, Révision W (© 2008-2024 HP).
Clean-room reference: built only from the guide's text and figures. Nothing was decompiled.

**Coverage note.** Sections on Enzyme Profile, PCR, Paste Special and the Randomize dialogs are based on the guide's text only. Their screenshots were not examined. All other dialog sections were checked against the rendered figures.

**Conventions**

- **Page numbers.** "p.N" is the PDF page. The printed footer number is the same.
- **Quotes.** Text in "double quotes" is copied verbatim from the guide.
- **INFERRED.** A rule derived from a figure or worked numbers, not stated in the text. Each one must be checked against the real software (see §10).
- **NOT IN GUIDE.** The guide has nothing on this point. Do not invent a behaviour for it: see §10.
- **Version caveat.** The guide is the HP-branded D300e manual. We are targeting Tecan D300e Control 4.0.1, and several protocol-file fields (backfill, cell dispense mode, surfactant-free cassettes, fluid order) are not described anywhere in the guide.

---

## 0. Glossary: guide terms vs. .tdd XML fields

| .tdd XML field | Nearest guide concept | Status |
|---|---|---|
| Plate `AssayVolume` (nL) | "Additional volume … the volume added to each well of the plate not using the dispenser" (p.22). The Plates report header calls it "Additional Volume (µL)" (p.88), while the text calls it "the defined assay volume of the plate" (p.88). | INFERRED: AssayVolume = Additional volume, stored in nL. Not confirmed; it could instead be the total. See §10. |
| `DMSOLimit` 0.01 | "DMSO limit (%)" plate field (p.22), shown as "1" in the dialog. | INFERRED: stored as a fraction (0.01 = 1 %). |
| Backfill `Type="ToMaxVolume"` | Normalize → "Normalize to highest class volume" (p.32), or "Normalize to highest fluid volume" on the Total Volume tab (p.33). | INFERRED. The word "backfill" never occurs in the guide. |
| Backfill `Type="ToAssayVolumePct" Param="0.01"` | Normalize → "Normalize to specified % of total volume" (p.32). | INFERRED: Param is a fraction (0.01 = 1 %). |
| `BackfillOrder="Mixed"` | Normalization "Dispense order": "strictly before or after the fluids or … with the fluids" (p.34). The UI shows "Before fluids" (p.33). | INFERRED: Mixed = "with the fluids". |
| `BackfillNoDispense` | "The dispense icon … allows you to not dispense all normalization fluids." (p.34) | INFERRED |
| `ShakeThresholdVolume` | "Volume Threshold (in nL)" for Shake during dispense (p.45). | Matches |
| `MolarityConcentrationUnit` µM | Current Protocol tab → "Concentration (molarity)" unit (p.44 figure). | Matches |
| Fluid `Concentration` 1000 + `ConcentrationUnit` mM | Fluid stock concentration and units (p.14). | Matches |
| Per-well value 0.02 (µM) | Programmed (requested) final well concentration for a by-concentration fluid (p.13, p.98). | Matches |
| `CellDispenseMode` | NOT IN GUIDE. The closest passage is the shake-for-cells advice (p.44-45). The guide says cells may not be dispensed (p.8). | Open |
| `PrioritizeSurfactantFreeCassettes` | NOT IN GUIDE. The guide only covers aqueous fluids "without the need for surfactant" (p.8) and the cassette-type choice (p.112). | Open |
| `FluidOrderRun` | NOT IN GUIDE | Open |
| Cassette names T8+ / D4+ | The guide mentions "T8+" only in figures (the head count is not given): "5 T8+ Dispenseheads (1 cassette)" (p.78) and Cassette Type "T8+" in the report (p.87). D4+ is not mentioned. | Partial |

---

## 1. Fluid list

### 1.1 Fields

The Fluid Edit dialog (figure, p.14) has these fields, in this order:

| Field | Values / rule | Source |
|---|---|---|
| Name | Free text. "Each fluid must be given a unique name" | p.12 |
| Fluid group | Drop-down. "In addition to DMSO fluids, there are additional classes based on aqueous fluids, and master mixes." The figure shows "DMSO". | p.15 |
| Fluid class | A drop-down that depends on the group. "Within each fluid group additional specifications can be defined with the fluid class selection drop down menu." The DMSO group has class "DMSO". The aqueous classes are listed in §1.3. Master-mix names are listed in Table 2, p.111. | p.15, p.111 |
| Concentration | A number plus a units drop-down ("10" "mM" in the figure). Molarity units (e.g. mM, µM) or mass/volume units (e.g. mg/mL, µg/mL, ng/mL). "If the stock concentration of a fluid is unknown, it must be dispensed by volume; the stock concentration may be left unspecified." | p.13-15 |
| Calculator button | "can be used to calculate a concentration, converting between units using molecular weight." Example: 7.5 mM × 5.23 kDa = 39.2 mg/mL, i.e. mass conc = molar conc × MW. | p.15 |
| Dispense by | Toggle: "Concentration" or "Volume". | p.13-14 |
| Source plate | Optional text. "included in the report file". | p.15 |
| Source well | Optional text. | p.15 |
| Color | Numbered palette drop-down (figure: "1", red). "The color used to identify the fluid in the protocol can be changed". | p.14-15 |
| Dispense | Yes / Don't Dispense (droplet icon). See §1.5. | p.15 |
| Small molecule | Checkbox. Shown only "For aqueous fluids with stock concentration specified in mass units". "small molecules are defined as molecules under 1000 Da." Checking it "prevent[s] the system from applying biomolecule dispense limits based on stock concentration". | p.15-16 |

The list rows show the name, the total volume used in the protocol ("3.6 µL"), the class and the stock concentration ("DMSO 10.0 mM"), plus icons for the dispense mode and for dispense/no-dispense (p.14).

### 1.2 Defaults

- "the fluid group, fluid class, concentration, and dispense by concentration/volume default to the values specified in Settings." (p.13)
- Adding a fluid with the "+" inside the Fluid Edit dialog "also copies the concentration, fluid class, dispense mode and source plate from the current fluid to the new fluid." (p.14)
- Settings › Default fluid values are: "Fluid class for new fluids", "Concentration and units for new fluids" and "Dispense mode for new fluids" (p.81).

### 1.3 Fluid classes (Appendix E, Table 1, p.111)

| Fluid class | Surfactant | Surfactant conc. | Glycerol |
|---|---|---|---|
| DMSO | n/a ("70-100% DMSO", p.109) | n/a | n/a |
| a+B | Brij 35 | 0.1 % | 0 - <5 % |
| a+B+g | Brij 35 | 0.1 % | 5 - 20 % |
| a + TX | Triton X100 | 0.1 % | 0 - <5 % |
| a + TX + g | Triton X100 | 0.1 % | 5 - 20 % |
| a + Tw | Tween 20 | 0.3 % | 0 - <5 % |
| a + Tw + g | Tween 20 | 0.3 % | 5 - 20 % |

- Long display names also appear: "Aqueous + Brij 35" (p.94) and "Aqueous+Tween 20" (p.15, p.33).
- The master-mix group contains the 13 named master mixes in Table 2 (p.111). "Master mix fluids (Table 2) do not require addition of surfactants." (p.110)
- A "surfactant-free" aqueous class is implied by p.8 ("aqueous fluids without the need for surfactant") but is not listed. → §10.
- A cell-class fluid is implied by a Synergy figure that reads "Titration is disabled for cell class fluids" (p.49). It is not listed. → §10.

### 1.4 Concentration vs. volume mode

- By Concentration: "the software uses the fluid stock concentration and total well volume to calculate what volume of the fluid is needed … The software maintains the programmed concentration in the well if other parameters, such as assay volume or stock concentration, are changed." (p.13)
- By Volume: "the software maintains the programmed volume in the well if other parameters are changed … If you adjust the stock concentration of a fluid dispensed by volume, the resulting concentration in the programmed wells will be adjusted because the dispensed volume will be maintained." (p.13)
- So each well stores one value per fluid. The value is a concentration when the fluid is in concentration mode and a volume when it is in volume mode. Everything else is derived.

### 1.5 Validation and editing rules

- Unit type: "Concentration can be specified in molarity or mass/volume units, but well concentrations cannot be converted between unit types. If unit type is changed and the fluid is used in the protocol, well fluid dispense values are maintained (concentration or volume depending on the Fluid dispense mode)." (p.15)
- Don't Dispense: the fluid can still be assigned to wells "but it will not be dispensed. This may be useful when you want a fluid to be used in Normalization calculations or to track controls" (p.15).
- Edits are staged: "If a fluid is changed, an Apply button will appear. You will also be prompted to save when closing the dialog box or selecting a different fluid to edit." (p.15)
- Remove: "selecting a fluid and pressing the Remove Selected button" (p.16).
- Reorder: drag within the editor (p.16).
- Create Diluted Fluids: "Multiple dilutions can be created at the same time. The new fluids will be inserted into the fluid list after the original fluid." (p.16)
- Derived fluids: "If a fluid is derived from another fluid using Creating diluted fluids or as the result of a Fluid shift or extend, some of the information cannot be edited and may change automatically when the source fluid is changed." (p.16) Also: "Diluted fluids are permanently associated with the original stock fluid. If the original fluid is modified (name, concentration, etc.) the diluted fluid will also be changed." (p.28)
  - Naming, INFERRED from the p.30 figure: "Compound B - 1:4".
- Total volume: "If the total dispense volume of a fluid exceeds the maximum dispense volume … the volume will be split between two or more dispense heads." (p.14)

---

## 2. Plate parameters

### 2.1 Plate Edit dialog fields (p.22 figure and text)

| Field | Rule |
|---|---|
| Name | "Use this name as your own reference to help you determine which plate to load during runtime." The default in the figure is "Quick Plate" for wizard plates; elsewhere "Plate 1". |
| Plate type | Drop-down. Types named in the guide: "48 well Plate" (p.22), "96 well Plate", "384 well", "1536-well", "24-well" (p.45). The full list is NOT IN GUIDE. |
| Additional volume (µL) | "the volume added to each well of the plate not using the dispenser and is used for concentration and normalization calculations" (p.22). Settings hold a default per plate type (p.81). |
| DMSO limit (%) | Manual entry; the figure shows 1. "DMSO limit is only displayed when DMSO fluids are in the protocol." (p.47) |
| Shake plate | Toggle. "The default setting when a plate is added is Don't Shake Plate, depending on the selection in the Current Protocol tab of the Ribbon. Don't shake is always set for 1536-well plates and cannot be changed." (p.22) |
| Dispense plate | Toggle. "Note that this setting is temporary; it is not saved with the protocol." (p.23) |

- Well volume limits per plate type are NOT IN GUIDE.
- The Plates report columns (p.88) reveal more per-plate attributes that the text never describes. The columns are: Plate, Plate Name, Plate ID, Type, Rows, Columns, Additional Volume (µL), DMSO Limit (%), Don't Shake, Don't Dispense, **Deionize**, **Prompt Plate Load**. In the example row, Deionize = Y and Prompt Plate Load = Y.
- "Plate ID is defined by the user within the run process the first time the plate is loaded" (p.88). Settings › Run › "Require and validate plate ID" (p.85).

### 2.2 Multi-plate rules

- "the plates in a multi-plate protocol do not need to be of the same plate type, nor do they need to have the same additional volume or DMSO limits." (p.22)
- Adding a plate with the plate-navigation "+" creates an empty plate with the Settings defaults. Adding it with the "+" inside Plate Edit "also copies the edit plate type, additional volume, and DMSO limit to the new plate." (p.22)
- Cancel in Plate Edit "will only cancel edits to the current plate, but it will not cancel saved changes to previously edited plates" (p.22).
- Plate N of X navigation uses Page Up/Down (p.21). Ribbon commands move a plate relative to the others (p.44).
- Aqueous limit: "it is recommended that protocols using aqueous fluid classes be limited to 1536 wells or four plates." (p.21) At run time this is a hard limit: "a protocol run dispensing aqueous fluid classes will be limited to 1536 wells or 4 plates." (p.78)
- DMSO limit: "Protocol limits (per fluid) 32 plates" (p.109).
- Best practice: "fewer than 100 fluids and 32 plates" (p.113).
- A new protocol is "created with a single plate using Default values from Settings." (p.17)

### 2.3 Well addressing and selection

- Rows are lettered and columns numbered: "A21, B14" (p.11).
- Rectangle drag selection; row/column header click; "All wells in a plate can be selected by double clicking on any well"; CTRL-click toggles; click outside the plate deselects (p.17).
- Locked wells "show a lock icon and cannot be selected." Pasting into a locked well gives the error "Cannot paste into locked wells." (p.43-44)

---

## 3. Design operations

All three value operations open one panel with tabs "Set Value | Titration | Targeted Titration" (p.23, p.25, p.27). The panel buttons are Cancel / Apply / Done: "'Apply' applies the function without closing the dialog box, while, 'Done' closes the dialog box." (p.19)

You can keep the panel open, select other wells, pick another fluid and Apply again (p.19). Re-applying over the same wells overwrites (p.19).

### 3.1 Conflict rule (Set Value, Titration, Targeted Titration), p.24

- "if the fluid was previously assigned to any of the selected wells, you will receive a warning message to Replace or Cancel. If you choose Replace, the newly defined values will overwrite the previous values for that fluid in the selected wells."
- "If different fluids were previously assigned to any of the selected wells, the new fluid will be added to, and not replace, the existing fluids."

### 3.2 Valid range shown in panels

- The panel shows "N wells selected" and "Valid range is <min> to <max> µM", with a paste button that fills these limits in (p.18, p.25).
- Set Value shows "0.000650 to 100 µM suggested" (p.23).
- "The high value is determined from fluid concentration and DMSO limit or recommended maximum aqueous dispense volume. The low value is limited by minimum dispense volume." (p.18)
- "the range minimum is a 'hard' limit based on dispenser drop size, but the upper limit is a suggestion" (p.23).
- Formula, INFERRED and verified against the screenshots in §6: min = the concentration produced by one minimum dispense (13 pL for DMSO); max = the concentration at which this fluid alone reaches the DMSO limit.
- If no value can be computed, the panel shows "Insufficient data to calculate" (p.26 figure).

### 3.3 Set Value (p.23-24)

- Fields: Fluid, and one value in the fluid's units (concentration or volume).
- "A diluted fluid may be suggested if the requested value with the stock fluid concentration would be significantly below the minimum dispense volume." (p.24)

### 3.4 Titration (p.24-26)

**"Specify titration using…"** has three radio options:

1. **Highest and lowest concentrations.**
   - Fields: Fluid, Highest concentration, Lowest concentration, Distribution, Replicates per level, Titration pattern.
   - Distribution is "Logarithmic or Linear".
   - Points are "equally spaced according to the selected distribution".
   - Logarithmic is geometric including both endpoints (verified on p.98 data: 100, 10.53874, 1.11065, 0.117049, 0.012335, 0.0013 is 6 points with ratio 9.4888 = (100/0.0013)^(1/5)). Linear is arithmetic including both endpoints (INFERRED).
2. **Highest concentration.** Give the high value and a Distribution: "1/2 Log, 1/3 -Log, 1/4-Log, 1:2, 1:3, 1:4, 1:N, or Linear".
   - The drop-down reads "1/2 Log, 1/3 Log, 1/4 Log, 1:2 (50%), 1:3 (33%), 1:4 (25%), 1:N, Linear" (p.26 figure).
   - "For 1:N, N is a numerical value greater than 1 (does not need to be an integer). For Linear, the value increment is also specified."
   - Each next level = previous ÷ N, or − increment for Linear.
   - 1/k Log INFERRED: step of 10^(1/k), i.e. ratio √10, ∛10, ⁴√10. → §10.
3. **Lowest concentration.** The same, going upward from the low value.

**Replicates per level**

- "The number of selected wells must be a multiple of Replicates. For instance, if 12 wells are selected, 3 replicates will result in 4 levels."
- Levels = selected wells ÷ replicates.

**Titration pattern**

- A graphic drop-down: "The graphics illustrate where the Highest and Lowest levels will be placed in the selected area as well as whether the titration is distributed by row or column."
- The exact pattern set is NOT IN GUIDE (figures show column-wise variants). → §10.

**Shift/extend.** "A fluid shift or extension may be suggested if the requested titration cannot be achieved with the stock fluid concentration specified." (p.25) See §3.6.

### 3.5 Targeted titration (p.27-28)

- "can only be programmed by specifying both the highest and lowest concentrations."
- Fields: Fluid, Highest, Lowest, Distribution, **Target** (conc), **Target region** (levels), **± Target range** (with unit "log" in the figure), Replicates per level, Titration pattern.
- Target "must lie within the Highest and Lowest concentrations".
- Target region: "These wells will lie on either side of the target concentration value."
- ± Target range "defines the concentration or volume range above and below the target value that will be covered by the specified number of wells."
- Figure example: target 0.5 µM, ± 0.25 log → 0.889 µM / 0.281 µM, i.e. target × 10^(±range).
- Allocation: "the software will always apply one well to each end concentration (the highest and lowest) and then any wells remaining after being distributed to the target region will be evenly spaced within each tail region."
- Figure example: 16 wells, Highest 50, Lowest 0.05, Target region 10. The diagram shows "Low - 2 levels", "High - 4 levels".
  - INFERRED: the 6 tail wells are split in proportion to each tail's log span. The high tail spans 50→0.889 = 1.75 decades, giving 4.2 → 4. The low tail spans 0.281→0.05 = 0.75 decades, giving 1.8 → 2.
  - The tail counts include the end wells.
  - The rounding rule is unknown. → §10.

### 3.6 Fluid shift / extend (p.28-31)

**Trigger.** Titration, Targeted Titration, Synergy, Quick Plate, Enzyme Profile or PCR "would result in well volumes significantly below the minimum well dispense volume". It can also come from Set Value and PCR.

**Candidate dilutions.** "an integral dilution of the selected fluid: 1:2 through 1:9, 1:10 through 1:90, etc. and less than 1:10,000 dilution."

- The candidate set is {2..9, 10, 20..90, 100, 200..900, 1000..9000}.
- "For a 1:20 dilution … 1 part of the original fluid to 19 parts diluent … a 5% solution".

**Shift vs. extend.**

- "If the titration can be accomplished with one fluid spanning the full concentration range requested, you will be offered a Fluid Shift."
- Otherwise a "Fluid Extension and the titration will be comprised of both the original stock fluid and the diluted extended fluid."

**Worked examples (p.29-30).** Plate: 200 µL additional volume, 1 % DMSO. Stock: Compound B, 5 mM.

- *Shift:* the request is 1 → 0.0001 µM (8 wells). The valid range with stock is 0.000325-50 µM. The offer is "Dilution Factor is 1:4 (25%)".
  - INFERRED rule: the smallest candidate ≥ 0.000325/0.0001 = 3.25 is 4.
  - Resulting fluid "Compound B - 1:4". Well A1 at 1.00 µM uses 160 nL (DMSO 0.0799 %), total volume 200.2 µL.
- *Extend:* the request is 5 → 0.00001 µM. The offer is "Dilution Factor is 1:40".
  - INFERRED: needed 0.000325/0.00001 = 32.5, and the next candidate is 40.

**Dialog.** "Use Shifted Fluid" / "Do Not Shift" ("Without fluid shift, the titration will include wells below the minimum dispense volume") / Cancel. The extend dialog is the same with "Extend".

**Extend constraint.** "If possible, the maximum DMSO % of the extended fluid will not exceed that of the original fluid in the titration. And, the maximum DMSO % of the extended fluid will never exceed that specified in the plate parameters." (p.31)

- Which levels go to which fluid is NOT IN GUIDE. → §10.

**Shift vs. extend criterion (INFERRED, fits both examples).** A shift is possible when one dilution D satisfies both limits: the requested lowest is ≥ the diluted fluid's minimum AND the requested highest is ≤ its maximum (S/D × DMSO limit). Example 1: 1:4 → 1.25 mM, range 0.0000813-12.5 µM, which covers 1-0.0001, so shift. Example 2: covering 0.00001 needs ≥ 1:32.5, but then the max is ≤ 1.54 µM < 5 µM, so extend.

**Declining.** "the titration will be completed using the original stock fluid, and the wells … outside the accessible range will be flagged as being below the minimum dispense volume."

### 3.7 Normalize (p.31-35)

The XML calls this "backfill" (INFERRED). See §5.

**Selection**

- Wells must be selected first, and may be on several plates.
- "A well can be included in multiple normalization groups, but there can be only one group for each fluid class."
- "Wells that are normalized together using the same options are referred to as a normalization group."

**Display**

- Normalized wells show a black tick lower-left.
- The tooltip lists "DMSO Volume … (%)", "Aqueous Volume", "Additional Volume", "Total Volume", each fluid, "DMSO Normalization Volume", and the group description, e.g. "Normalize DMSO to highest volume: 186 nL" (p.33).

**Commands**

- Remove Normalization asks "Remove all normalization from selection?" with Yes/No (p.34).
- Select Normalization Group selects every well in the same group, and asks which group if the well belongs to several (p.35).

### 3.8 Randomize (p.35-37)

**Scope**

- "Randomization is a 'per plate' feature. It is not possible to create separately randomized regions within a single well plate."
- "If you later wish to add more randomized wells to the plate, they will be added to the rest of the randomized wells with all randomized together as one group."
- Randomized wells show a white tick lower-right and a "Randomized" tag in the tooltip.

**What is stored (INFERRED from reports).** A per-plate permutation that maps each design (non-random) well to its dispensed well. The well contents keep their non-random positions.

- Evidence: reports carry both "Dispensed Well/Row/Col" and "Non-random Well/Row/Col" (p.88-90).
- Show Randomized toggles the view between the two (p.40).
- "if you are viewing wells as randomized, some other functionality will be limited" (p.36).
- Copy Wells "does not function when viewing randomized" (p.97).

**Commands**

- Remove Plate Randomization (current plate, with confirmation).
- Copy Plate Randomization: source → target, or "All similar plates" (same dimensions only), or the Clipboard.
- Paste Plate Randomization.

The random algorithm and seed are NOT IN GUIDE.

### 3.9 Copy / paste within the software (p.37-39)

**Copy/Cut/Paste Wells**

- "Cutting wells" makes the selected wells revert to empty.
- The paste target is the upper-left well.
- "The pasted wells will overwrite, without warning, any other well contents."
- When the paste does not fit, a truncation warning offers continue or cancel.
- "All fluids and normalization are included in copy, cut, and paste. When copying to an external application (e.g. Excel), however, normalization is not included."
- "Pasting wells overwrites any current information in the target wells or plates." (p.37)

**Copy All Wells**

- Copies the whole plate. Plate types may differ.
- Lower → higher density copies all wells, and the result "may be that the wells all fit and become one quadrant of the new plate".
- Higher → lower density truncates, with a warning.
- "all fluids and normalization are copied but randomization is not copied. Additionally, target plate parameters such as additional volume and DMSO limit, are not copied."
- If the target is not empty you are warned. If you do not replace all, the fluids are merged, except that "the same fluid occurred in both the source and target plates, in which case that fluid will be replaced."

**Paste Special**

- Maps each source fluid to a target fluid, or to "don't paste".
- Options: "Paste normalization", "Replace all fluids in the paste region", "Transpose rows and columns".
- "You cannot map fluids that have different unit types (molarity vs. mass/volume) or dispense modes".

### 3.10 Plate functions (Advanced tab, p.41-43)

| Command | Behaviour |
|---|---|
| Remove Plate | Asks for confirmation. Also available from the plate editor: select plate icons, then Remove Selected. Several plates can be removed with CTRL-click on names, then right-click › Remove Plates. |
| Clear Plate | Asks for confirmation. "does not remove fluids from the Fluids List". Works on several plates via CTRL-selection. |
| Replicate Plate | Creates a new plate "with the exact characteristics of the current plate, including Normalization and Randomization", "appended to the end of the plate series; the new plate becomes the current plate." |

### 3.11 Ribbon – Advanced tab (p.43-44)

- **Copy All Fluids / Paste Fluids / Replace Fluids.** See §9.3.
  - Paste "modif[ies] any changed parameters of existing fluids in the target protocol (matched by name) and append[s] new fluids".
  - Replace "will replace each existing fluid with pasted fluids in the order they occur … Certain fluid properties cannot be changed (unit type)."
- **Lock / Unlock wells.**
- **Plate moves.**
- **Utilities.** These need a device: Cassette Check, Set Device ID ("included in reports"), A1 Alignment.

### 3.12 Ribbon – Current Protocol tab (p.44-45; settings are saved in the protocol)

**Units**

- Fields: "Concentration (molarity)" (e.g. µM), "Concentration (mass)" (e.g. ng/mL), "Volume" (e.g. nL).
- "Well fluids are displayed using the specified units".
- INFERRED: these are display/entry units, and the stored per-well values in the XML are in these units (the XML has a µM per-well value).

**Shake during dispense**

- Fields: a checkbox and "Volume Threshold (nL)" (figure 100; the p.78 figure shows 1000).
- Shaking happens "for every well dispensed for all fluids, as long as the dispensed volume exceeds the programmed Volume Threshold".
- "recommended that shake during dispensing is turned on for any volumes greater than 100nL" for DMSO onto cells.
- "Shake during dispense is automatically enabled when a low-density plate (48 wells or fewer) is created, however, it can be disabled."
- "Shaking is always disabled for 1536-well plates".

**Shake after each dispense head**

- Fields: a checkbox and "Duration (sec)".
- Typical values: "3 seconds for a 384-well plate or 20 seconds for a 24-well plate".
- "not recommended when dispensing aqueous fluids."

**Other controls**

- **Label** text field (figure only).
- **Last run summary › View** (figure only).

### 3.13 Undo (p.19)

- "click the Undo icon in the Home tab … or use the keyboard shortcut (CTRL-Z)."
- Depth and redo are NOT IN GUIDE.

### 3.14 View / Show (p.40)

- View: One Plate / All Plates; double-click a plate border to fit it.
- Show: Show Normalization, Show Randomized, Show Fluids ("All fluids", "Dispensed fluids", "Only the fluid selected from the list").

---

## 4. Special features (wizards)

What all wizards share:

- They do not use the current selection: each "automatically creates new plates with the programmed well content and ignores any wells that you may have already selected" (p.46, 52, 64, 69).
- The Plate page defaults to "the current plate's parameters" (except PCR: additional volume = 0).
- Clicking a row letter or column number toggles exclusion of that row or column.
- On Finish, the new plates are appended and "become the current plate".
- "If Aqueous fluids are in use for the … wizard and more than 4 plates are generated a warning message is displayed." (p.52, 57, 68)
- "You cannot select … fluids with different unit types (molarity vs. mass/volume) or dispense modes (by concentration/volume)" in one list (p.50, 54, 65, 73).
- Every titration page can trigger shift/extend (§3.6).

### 4.1 Synergy (p.46-52)

**Wizard pages: Type → Plate → Titration → Layout → Summary.**

**Type page.** Two experiment types:

- **A\*B\*C**: "Two or more fluids factored together." All fluids are fully crossed.
- **A\*B A\*C A\*D A\*E**: "One fluid factored with one or more fluids individually." One primary fluid is crossed with each secondary fluid separately.

**Plate page**

- Fields: Plate type, Additional volume (µL), DMSO limit (%), and the row/column exclusion grid. The example excludes rows A, H and columns 6, 7.
- When exclusions exist, a checkbox reads "Primary synergy grid must fit in each plate region; regions are formed by excluded rows and columns". The text says: "keep the primary Synergy grid from crossing excluded wells (if possible)."

**Titration page, A\*B\*C**

- Header: "8 rows available per plate" and "12 columns available per plate". These are the non-excluded counts.
- "The first fluid will flow down the non-excluded rows and the second fluid will flow across the non-excluded columns."
- "+" adds a fluid panel (3rd, 4th, …), and a red ✕ removes one.
- Each fluid panel has:
  - tabs Set Value | Titration | Targeted Titration;
  - **Titration levels** (number);
  - Specify titration using (H&L / Highest / Lowest);
  - Fluid;
  - Highest / Lowest;
  - **Include "0" value** (checkbox, checked by default in the figures);
  - Distribution;
  - **Order** ("High to Low" / "Low to High");
  - Valid range with a paste button.
- There is no Replicates field in the synergy panels (figures). Replicates are not described for Synergy. → §10.
- The figures show a "▸⧉" button between panels whose function is not described (probably copies the settings to the next panel). → §10.

**Titration page, A\*B A\*C… (p.49-50)**

- "The primary titration fluid is used for non-excluded rows of the synergy grid. A separate grid will be created for each secondary fluid. The secondary fluid will flow across non-excluded columns."
- Secondary fluids are picked from a checkbox list with a select-all "Fluids" checkbox and an "N fluids selected" count.
- One titration panel is shared by all secondaries.
- The figure shows the secondary panel in volume units with the text "Titration is disabled for cell class fluids".

**Generated concentrations**

- Each fluid's levels are computed exactly as in Titration/Targeted/Set Value, using its own number of levels.
- INFERRED: with Include "0" checked, a 0 level is added in addition to the entered number of levels. → §10, check whether it adds a level or replaces one.
- Order sets which end of the row/column axis holds the highest level.

**Primary grid size (INFERRED)**

- Rows = levels(A) (+1 if A includes 0). Columns = levels(B) (+1 if B includes 0).
- These must fit within the available rows and columns.

**Valid range and the DMSO limit**

- Raw observations (p.48 figures; 100 µL additional volume, 1 % limit, stocks A = 10 mM, B = 5 mM, C = 10 mM as inferred from the minima). In the 2-fluid figure, A shows 0.00130-100 µM and B shows 0.000650-50.0 µM (B's own stock at 1 %). In the 3-fluid figure, A shows 0.00130-50.0, B 0.000650-50.0 and C 0.00130-50.0.
- An even 3-way split of 1 % would not give 50 µM for the 10 mM fluids, and the rule behind A's max dropping from 100 to 50 µM is unknown. NOT IN GUIDE. → §10.

**Layout page (p.50-51).** Four options:

1. "**Layout does not leave empty wells**: This option fills in all the wells along the columns, starting in A1, and does not leave empty rows or columns. It might not result in neatly ordered titration levels. Wells are filled by row or column as specified."
2. "**Each plate contains a single grid**".
3. "**Each plate contains multiple grids**: If multiple copies of the primary synergy grid can be placed on a plate, they will be placed by row or column as specified." The sub-options are "Layout grids by rows." / "Layout grids by columns."
4. "**Each plate contains multiple grids, with plate breaks**: Plate breaks will be made to keep titration sequences together."
   - Verbatim examples: "If 9 primary synergy grids fit on each plate. If 3rd fluid has 5 levels and 4th fluid has 3 levels, 5 grids will be placed on each plate. If 3rd fluid has 2 levels, 4th fluid has 4 levels, and 5th fluid has 3 levels, 8 grids will be placed on each plate."
   - INFERRED rule (fits both examples): grids per plate = the largest prefix product L3, L3·L4, L3·L4·L5, … that is ≤ capacity. Here 5 ≤ 9 < 15, and 2·4 = 8 ≤ 9 < 24.
   - An alternative that also fits both examples: the largest divisor of the total grid count that is ≤ capacity. → §10.

Options 2-4 share this rule: "titration levels of the first 2 fluids determine the number of rows and columns in the layout grid. They start by creating a primary synergy grid from the first two fluids, repeating that grid combined with the remaining fluids as needed."

- Each repeat of the grid gets one combination of the levels of fluids 3+.
- The order of the combinations is NOT IN GUIDE (INFERRED: the 3rd fluid varies fastest, which is consistent with "plate breaks keep sequences together").

"Not all of the layout options may be available, depending on the synergy Type, Titration options and Plate options."

**Summary page**

- Shows "N Wells" and "N Plate(s)", a preview with tooltips, a "Normalize Wells" button (opens §3.7 for all synergy wells) and a "Randomize each plate" checkbox ("Each plate will be randomized separately").
- Buttons: Finish / Back / Cancel.
- The example summary shows 32 wells on 1 plate, as two 4×4 grids (cols 1-4 and 7-10, rows A-D).

### 4.2 Quick Plate (p.52-63)

Purpose: "a group of identical titrations using multiple different fluids … The titrations can span multiple plates but must have the same concentrations and number of replicates."

**Wizard pages: Plate → Titration → Layout → Summary.**

**Plate page**

- Fields: Plate type, Additional volume, DMSO limit, and the exclusion grid.
- With exclusions, the checkbox reads "Layout options are applied to each plate region; regions are formed by excluded rows and columns". "The default is to skip over excluded rows and columns during layout."

**Fluid & titration page**

- Fluid checkbox list with select-all.
- The header reads "R rows, C columns available per plate".
- Tabs: Titration | Targeted Titration (no Set Value).
- Fields: **Titration levels**, Specify titration using (3 options), Highest, Lowest, Distribution, **Replicates per level**, **Order** (High to Low / Low to High), Valid range.
- All selected fluids get the same values.

**Layout page**

- **Layout**: "Layout by rows" ("each fluid's replicate levels progressing across a row") / "Layout by columns" ("progressing down a column").
- **Replicate layout**: checkbox "Keep replicate levels together".
  - Checked: "will keep all the concentration replicates of each fluid together."
  - Unchecked: "will instead keep the fluid's titration series, of decreasing concentration, together."
- **Interleave fluids** (radio; the second option depends on the checkbox):
  - "Do not interleave": "The wells for each fluid are maintained together".
  - "Change fluid after each level replicate" (only when keeping replicate levels together): "After all the replicate[s] for a given fluid level are applied, the next fluid will then be placed into the wells, until all of the fluids are placed. Then, the next set of level replicates for the first fluid will be applied, etc."
  - "Change fluid after each singlicate" (only when not keeping replicate levels together): "All the titration levels for a single fluid are applied to the wells, then the titration levels of the next fluid are applied, until all the non-replicated fluid titration levels are applied. Then the replicates for all the fluids are applied in the same manner."
  - "Change fluid after each well". If replicates are together: "places the first titration level of each fluid into the wells, changing fluid for every well. Then the replicates for all the fluids are applied in the same manner, followed by the other titration levels". If not: "places the first titration level of each fluid … changing fluid for every well. Then it places the next titration level for each fluid in the same manner until all the singlicates for all the fluids have been placed. Then the replicates…".
- **Example layout options**: thumbnails of final flow variants. "These options vary significantly based on previous selections. Move the mouse over an option to display a brief description". Their exact semantics are NOT IN GUIDE (Example 3 calls one "starting each level on a new column"). → §10.

**Summary page:** illustration, well and plate counts, Finish/Back/Cancel. Normalize and Randomize are not mentioned for Quick Plate.

**Worked examples to use as acceptance tests**

| # | Setup | Settings | Result |
|---|---|---|---|
| 1 (p.58-59) | 96-well, nothing excluded, 4 fluids (10 mM DMSO), 8 levels, Log 100 → 0.0013 µM, 3 replicates, High to Low, additional 100 µL. Valid range 0.00130-100 µM. | Layout by columns, keep replicate levels unchecked, Do not interleave, first example option | Fluid 1 in cols 1-3, Fluid 2 in cols 4-6, Fluid 3 in cols 7-9, Fluid 4 in cols 10-12. Each column runs A (highest) → H (lowest), one replicate series per column. 1 plate. |
| 2 (p.60-61) | 3 × 96-well, perimeter excluded (6 rows × 10 columns available), 6 fluids, 10 levels, Log 100 → 0.0013, 3 replicates | Layout by rows, keep unchecked, "Change fluid after each singlicate" | 3 plates. On each plate, rows B-G = fluids 1-6 and cols 2-11 = levels high → low. Replicate k is on plate k. |
| 3 (p.62-63) | 384-well, cols 1-2 excluded (16 rows × 22 columns available), 16 fluids, 10 levels, Log 100 → 0.0026, 2 replicates, additional 50 µL. Valid range 0.00260-100 µM. | Layout by columns, keep replicate levels together (checked), "Change fluid after each level replicate", option "starting each level on a new column" | From the figure: col 3 = level 1 of fluids 1-8 (rows A/B = fluid 1 ×2, C/D = fluid 2 …), col 4 = level 1 of fluids 9-16, col 5-6 = level 2, … col 21-22 = level 10. Cols 23-24 empty. |

### 4.3 Enzyme Profile (p.64-68)

**Wizard pages: Plate → Fluids → Type → Titration → Layout → Summary.**

- **Plate page:** as in Quick Plate.
- **Fluids page:**
  - "You must select one or two enzymes."
  - "You may select one or two substrates/cofactors, but you do not need to select any."
  - "You may select one or more inhibitors, but you do not need to select any. All inhibitors will be titrated using the same settings."
- **Type page:** "Select one or two fluids for titration. Fluids not selected for titration will be dispensed at a fixed volume or concentration." With two, choose which one goes down rows and which across columns.
- **Titration page:**
  - Titration / Targeted Titration, Titration levels, Include "0" value.
  - "Distribution is pre-selected as Linear or Logarithmic depending on the type of fluid" (the rule is NOT IN GUIDE).
  - Two titrated fluids form a grid.
  - Fixed fluids get a single value.
- **Layout page:** options vary. One checkbox is "Allow multiple layout grids per plate".
- **Summary page.**

### 4.4 PCR (p.69-76)

**Wizard pages: Plate → Fluids → Unknown Groups → Standards/NTCs → Layout → Summary.**

**Plate page.** "additional volume will always default to 0 (zero) for PCR". If the master mix is added another way, enter its volume as Additional volume.

**Fluids page**

- Master Mix / Primer / Sample categories. "Only fluids dispensed by volume are included in the Master Mix selection list."
- At least one primer and one sample are required. Master mix is optional.
- Optional reporter, quencher and Biogroup info. Reporter is required for QuantStudio export.
- "Assign PCR Fluids" to modify the PCR fluid tasks.

**Unknown Groups page**

- Per master mix: one dispense volume, "dispensed in all Unknown, Standard, and NTC wells".
- Groups are added with "+". Per group:
  - Replicates;
  - "All Primers in the group share a single dispense value";
  - "All Samples in the group share a single dispense value";
  - "Each Sample will be dispensed separately with all Primers in the group" (primers are multiplexed).
- Example: 4 samples × 8 replicates = 32 wells; 2 samples × 6 replicates = 12 wells.

**Standards/NTCs page**

- Standards (optional): primers with a fixed value; samples each with their own titration; the titration's replicates set the number of standards per primer/sample combination. "Each primer will be combined separately with each sample."
- NTC (optional): Replicates and primers with a fixed value; "Each primer is dispensed separately."
- "If Standards/NTCs on each plate is not checked, standards and NTCs will only be dispensed on the first PCR plate."

**Layout page**

- Standards/NTCs go down the left and right edges or along the top and bottom.
- "Standards can be condensed … The NTC region is always condensed."
- A columns-per-combination setting is available.
- A "does not leave any empty wells" checkbox is available.
- "all replicated combinations will be planned on the same plate".

**Summary page:** optional Normalize (typically water + surfactant, aqueous class).

**Manual specification.** Well task assignment through the PCR ribbon menu or right-click: Unknown/Standard/NTC, and remove.

---

## 5. Backfill (= Normalization in the guide)

The guide never uses "backfill". Everything below maps guide normalization onto the XML. The mapping is INFERRED.

**Two tabs (p.32-33)**

- **Normalize Fluid Class** (adds fluid of one class; counts only that class's titration fluid):
  - "Normalize to highest class volume": V_norm(w) = max over the group of V_class − V_class(w). "It will not add normalization fluid to the highest volume well." → XML `ToMaxVolume` (probably).
  - "Normalize to specified volume": V_norm(w) = max(0, V_spec − V_class(w)). "unless the titration fluid volume already equals or exceeds the specified volume, in which case no normalization fluid will be added."
  - "Normalize to specified % of total volume": choose V_norm(w) so that V_class(w) + V_norm(w) = p × V_total(w), where V_total(w) = additional + all dispensed + V_norm. "It will not add normalization fluid to wells that contain titration fluid equal to or in excess of the specified %." "each well is normalized to the volume appropriate for the well. This includes additional volume that may be different for each plate". → XML `ToAssayVolumePct`, Param = p as a fraction (0.01 = 1 %).
    - Closed form (INFERRED): V_norm = (p·(A + D_other) − (1−p)·V_class)/(1−p), where A = additional volume and D_other = dispensed volume of the other fluids. Concentrations then shift, so iterate as in §6.
- **Normalize Total Volume** (all fluids regardless of class, plus Additional volume; one class is chosen for the normalization fluid via "Normalize using fluid class"):
  - "Normalize to highest fluid volume" (UI: "highest total total volume"): fill up to the group's maximum of (additional + all dispensed).
  - "Normalize to specified volume" (UI: "specified total volume"): fill up to V_spec unless already ≥.

**Minimum volume.** "Normalization cannot dispense a quantity lower than 1nL per well. If normalizing a well requires dispensing less than 1nL of fluid, no fluid will be added to that well." (p.31)

- Normalization volumes are then rounded to the bulk increment. Report evidence (p.89): Fluid 2 1.58 nL + norm 98.4 nL; 0.4 + 99.6; 25.2 + 74.8 (target 100 nL); and 0.1 + 100 where 99.9 was rounded to the 0.4 nL grid.

**Normalization fluid identity**

- One implicit fluid per class, shown as "DMSO normalization" / "DMSO Normalization" in tooltips and reports.
- It is listed as a fluid in reports, with Class DMSO, its own dispense head and load volume.
- It has no concentration: "Normalization fluids do not have a dispensed concentration." (p.89)

**Dispense order (BackfillOrder)**

- "Normalization fluids can be dispensed strictly before or after the fluids or they can be dispensed with the fluids." UI value "Before fluids".
- Settings › Normalization › "Default dispense order" (p.81).
- Report Summary shows "Normalization Dispense order … No priority" (p.87). INFERRED: "No priority" = "with fluids" = XML `Mixed`.
- "When dispensing a protocol using high-volume cassettes, the Dispense order may cause dispensing to alternate between cassette types."

**BackfillNoDispense.** "The dispense icon … allows you to not dispense all normalization fluids." (p.34) This is a protocol-wide flag that applies to all normalization fluids.

**Iteration failure.** "it is possible to Normalize wells using Normalize to % of total volume with a percentage high enough where a solution does not exist … a warning is displayed for affected wells." (p.108)

**Display.** The Normalization panel shows "Total volume" per class (e.g. "DMSO 12.3 µL, a+Tw 2.2 µL"), the dispense icon and the "Dispense order" drop-down (p.33).

---

## 6. Appendix D – concentration calculations (p.108) and derived formulas

**Verbatim rules**

- "Each protocol plate has a specified additional volume … The total assay volume will be this additional volume plus volume dispensed by the dispenser."
- "Calculation of true concentration must be accomplished iteratively since adding fluid with the dispenser changes the overall assay volume which in turn changes concentrations. Calculation of concentration utilizes well volumes that include both dispensed fluids and user-added Additional volume".
- "Prior to software release 3.2, concentrations were calculated without including the volume dispensed".
- "Since fluid is dispensed in increments of dispense head drops, for low volumes the well content information will display both requested and dispensed concentrations and volumes … The actual concentration and volume is shown in brackets." (p.11)
- "the report file will show only the concentration/volume actually dispensed." (p.11)

**Derived model (INFERRED; the guide gives no explicit formula)**

For well w on a plate with additional volume A:

- Concentration-mode fluid i: requested C_i, stock S_i.
- Volume-mode fluid j: requested V_j.
- Normalization volume N.

1. V_total = A + Σ_i V_i + Σ_j V_j + N
2. V_i = C_i · V_total / S_i, i.e. C_i = S_i · V_i / V_total.
3. With N fixed, this is linear: V_total = (A + ΣV_j + N) / (1 − Σ_i C_i/S_i). No solution exists if Σ C_i/S_i ≥ 1.
   - The guide says "iteratively". The fixed point is the same. Iteration is required once N depends on V_total (the % normalization).
4. Rounding: requested volumes are rounded to the dispense-increment grid of §7, by fluid class and volume band. Dispensed concentration = S_i · V_i,rounded / V_total,rounded.
   - Requests below the minimum dispense volume give "Below minimum dispense volume" (p.11).
5. Concentration units: convert S_i and C_i into one unit before taking the ratio. A mass-unit fluid needs only mass units (no conversion between molarity and mass at well level, p.15).
6. Volume-mode fluid with a known stock: displayed concentration = S_j · V_j / V_total (p.13).
7. DMSO %: DMSO % = Σ (DMSO-class fluid volumes + DMSO normalization) / V_total. "Only DMSO fluids and DMSO normalization are included in this calculation." (p.89) The DMSO fluid is treated as 100 % DMSO (INFERRED).

**Verification against guide numbers**

The p.89 Tabular Detail example uses A = 100 µL and Fluid 1 at 10 mM DMSO, in increments of 400 pL > 3.6 nL and 20 pL ≤ 3.6 nL.

| Requested (µM, back-calculated: the report shows only dispensed values) | V_exact from (3) (nL) | Rounded (nL) | Report volume | Report conc (µM) |
|---|---|---|---|---|
| 50 | 50·100000/(10000−50) = 502.51 | 502.4 | 502.4 (total well 100502.4 nL) | 49.9889 ✓ (= 10000·502.4/100502.4) |
| 10 | 100.10 | 100.0 | 100 | 9.99000999 ✓ (= 10000·100/100100) |
| 2.512 (log 10 → 0.01, 6 points) | 25.13 | 25.2 | 25.2 | 2.51936 ✓ |
| 0.631 | 6.31 | 6.4 | 6.4 | 0.63996 ✓ |
| 0.1585 | 1.585 | 1.58 | 1.58 | 0.15798 ✓ |
| 0.0398 | 0.398 | 0.40 | 0.4 | 0.039999 ✓ |
| 0.01 | 0.100 | 0.10 | 0.1 | 0.00999 ✓ |
| 0.0013 | 0.013 | 0.013 | 0.013 | 0.0013 ✓ |

This confirms both the iterative total volume and rounding to the nearest increment.

**Valid-range limits** (p.23/25/27/29 screenshots, 1 % DMSO limit):

- Min = S · V_min / (A + V_min) with V_min = 13 pL.
  - 10 mM at A = 200 µL → 0.000650 µM ✓
  - 5 mM → 0.000325 ✓
  - A = 100 µL → 0.00130 ✓
  - A = 50 µL → 0.00260 ✓
- Max (this fluid alone at the DMSO limit L): V/(A+V) = L → V = L·A/(1−L); C = S·L.
  - 10 mM × 1 % = 100 µM ✓, independent of A.
  - 5 mM → 50 µM ✓
- p.30 tooltip: 1.00 µM of the 1.25 mM fluid in 200 µL is 160 nL, DMSO 0.0799 %, total 200.2 µL ✓.
- The p.98 copy example (requested values, A = 100 µL implied) also fits: Fluid 1 at 10 mM gives 100-0.0013 µM; Fluid 3 at 20 µg/mL gives 200-0.0026 ng/mL; Fluid 2 by volume gives 1000-0.013 nL.

---

## 7. Appendix E – dispense specifications

### 7.1 DMSO dispensing (p.109)

Applies to "70-100% DMSO" and "Nanoparticles < 1 micron … at concentrations ≤ 0.5%".

| | Standard-volume cassette | High-volume cassette |
|---|---|---|
| Maximum dispense volume per dispense head | 10 µL | 200 µL |
| Maximum dispense volume per dispense head – normalization and bulk dispense¹ | 20 µL | 200 µL |
| Minimum dispense volume | 13 pL | 1 nL |
| Minimum dispense volume – normalization and bulk dispense¹ | 1 nL | 1 nL |
| Minimum fill volume | 2 µL | 50 µL |
| Maximum dispense volume – each fluid per well | 10 µL | 10 µL |
| Dispense increment (per well) | 400 pL for > 3.6 nL; 20 pL for 17 pL - 3.6 nL; 13 pL for < 17 pL | 400 pL for > 3.6 nL; 20 pL for 1 - 3.6 nL; n/a for < 1 nL |
| Protocol limits (per fluid) | 32 plates | 32 plates |

¹ "Bulk Dispense is defined as when all dispensed volumes for a fluid are 1nL or greater."

### 7.2 Aqueous dispensing (p.110)

Applies to aqueous fluids "including surfactant and glycerol", with "Total buffer components < 150 mM".

| | Standard-volume cassette | High-volume cassette |
|---|---|---|
| Maximum dispense volume per dispense head | 10 µL | 200 µL |
| Max per dispense head – normalization and bulk dispense¹ | 20 µL | 200 µL |
| Minimum dispense volume | 11 pL | 1 nL |
| Minimum dispense volume – normalization and bulk¹ | 1 nL | 1 nL |
| Minimum fill volume | 4 µL | 50 µL |
| Maximum dispense volume – each fluid per well | 10 µL | 10 µL |
| Dispense increment (per well) without glycerol | 560 pL for > 3.6 nL; 11 pL for ≤ 3.6 nL | 560 pL for > 3.6 nL; 11 pL for 1 - 3.6 nL; n/a for < 1 nL |
| Dispense increment (per well) with glycerol | 600 pL for > 3.6 nL; 12 pL for ≤ 3.6 nL | 600 pL for > 3.6 nL; 12 pL for 1 - 3.6 nL; n/a for < 1 nL |
| Protocol limits (per fluid) | 1536 wells or 4 plates² | 1536 wells or 4 plates² |

¹ Bulk, as above. ² "To minimize evaporation."

**Interpretation for implementation (INFERRED)**

- A volume in band "> 3.6 nL" is a whole multiple of the large increment.
- For DMSO standard, the 17 pL-3.6 nL band is a multiple of 20 pL. Note that 13 pL is "13 pL for < 17 pL", so the only value below 17 pL is 13 pL.
- The report shows 0.013, 0.1, 0.4, 1.58 nL in the ≤ 3.6 nL band and 6.4, 25.2, 100, 502.4 nL above it. This is consistent.
- Exact boundary handling (e.g. 3.6 nL itself) is unknown. → §10.
- The guide lists no surfactant-free aqueous class, master-mix specifications or cell-class specifications.

### 7.3 Table 3 – example compatible biomolecules (p.111)

- Compatible: Enzymes < 300kDa; Antibodies; Peptides; Oligos and labeled oligos; Lipids; Small molecules such as ATP, ADP; PCR Master mix; DNA < 10,000 base pairs.
- Not compatible: Enzymes > 300kDa; Saliva; Whole blood; Plasma; Serum.

### 7.4 Cassette mode selection (p.112) and Table 4

There are "three potential modes": high-volume 200 µL, standard 20 µL, standard 10 µL.

- "the first consideration is the lowest volume to be dispensed into any well using that fluid. If any well has less than one nL, then standard-volume cassettes dispensing 10 µL will be used … If all wells for a fluid are greater than one nL, then Table 4 should be used. The more concentrated the fluid, the less total volume can be reliably dispensed. If the DMSO fluid class is used, or if the biomolecule concentration is not entered in mg/mL, then the most economical option is used".

Table 4 – dispense limits:

| Mode | Small molecules | Biomolecules |
|---|---|---|
| Standard-volume 10 µL | 1000 Da, 10 mM | 300 kDa or 10,000 base pairs, 3 mg/mL |
| Standard-volume 20 µL | 1000 Da, 10 mM | 300 kDa or 10,000 base pairs, 1 mg/mL |
| High-volume 200 µL | 1000 Da, 10 mM | 300 kDa or 10,000 base pairs, 0.3 mg/mL |

"high-volume cassettes have a greater dead volume … If there is an extremely precious fluid, deselect 'Use high-volume cassettes'".

**Cassette types**

- The figures show "T8+" ("5 T8+ Dispenseheads (1 cassette)", p.78). INFERRED: 8 heads per T8+ cassette, from the name only.
- A high-volume cassette name and head count are NOT IN GUIDE (D4+ is presumably high-volume). → §10.

---

## 8. Pre-run computations and displays

### 8.1 In the designer

- **Fluid list.** Each fluid shows its total volume used in the protocol (p.14). This is the sum of dispensed volumes across wells, excluding Don't-dispense plates (INFERRED). The Run screen shows a separate, larger "load" volume.
- **Well tooltip** (p.11, p.30, p.33), with requested and [actual] values for each fluid:
  - plate and well;
  - DMSO Volume (% of total);
  - Aqueous Volume;
  - Additional Volume;
  - Total Volume;
  - for each fluid: name, mode icon, class, Concentration, Volume;
  - normalization lines;
  - "Randomized" tag;
  - PCR info.
- **Warnings:**
  - "Below minimum dispense volume." (p.11)
  - Concentration cannot be computed when % normalization has no solution (p.108).
  - Replace/Cancel on re-assigning a fluid (p.24).
  - Paste truncation; plate size mismatch; non-empty target; locked wells.
  - More than 4 aqueous plates in a wizard (p.52).
  - The DMSO limit is soft: the Set Value upper bound is "a suggestion" (p.23).
  - A design-time DMSO-exceeded warning is NOT IN GUIDE. → §10.
- **Colour.** "each well is color-coded to indicate the fluid(s), as well as their respective concentration or volume – as indicated by the color saturation" (p.11). The saturation mapping (log scale?) is NOT IN GUIDE.

### 8.2 Run window, "Pre-run Summary" (p.77-78)

- Run checks the device and offers Simulate / Retry / Cancel. "Always Simulate" turns the Run button into Simulate (p.77).
- **Requirements panel:**
  - "<n> T8+ Dispenseheads (<k> cassette)";
  - "<n> Fluids";
  - "<n> Normalization fluid";
  - "If high-volume dispense heads are appropriate … the number of dispense heads will be listed for each cassette type";
  - a "Use high-volume cassettes" checkbox (its default comes from Settings › Run).
- **Report Notes** text and per-fluid **Fluid Notes**.
- **Total load volumes** per fluid, plus normalization. Example: 4 fluids at 6.4, 6.4, 7.6, 7.2 µL and DMSO normalization 13 µL. The report lists Loaded 6.4 vs Dispensed 5.3 µL.
  - Load = dispensed + an overhead, with a minimum fill of 2 µL (DMSO) or 4 µL (aqueous) (p.113: "minimum volume requested for the fill is 4 µL for aqueous fluids as opposed to a 2 µL minimum … for DMSO").
  - The overhead formula is NOT IN GUIDE. → §10.
- **Head splitting.** Fluid > max per head → split over heads "approximately equally", and a well may be "Multiple" heads (p.89).
- **Shake parameters.** They are editable here: "Changing these parameters changes the protocol." "individual plates may have Don't Shake Plate selected."
- **Advice.**
  - "all plates include a well with volume of 30nL or greater for each fluid" (p.78, p.113).
  - DMSO pre-filled heads should be used within 30 min, and pauses kept under 15 min (p.113).
  - Aqueous: no prefill, no pauses, no shake after each head (p.113-114).
- **Not described:** cell dispense mode, fluid order, prioritizing surfactant-free cassettes, plate-order logic.

---

## 9. Settings, reports, copy/paste formats

### 9.1 Settings (File › Settings, p.80-85)

| Section | Item | Control |
|---|---|---|
| Default protocol values | Molarity concentration units for new protocols | drop-down |
| | Mass concentration units for new protocols | drop-down |
| | Volume units for new protocols | drop-down |
| | Enable shake during dispense | checkbox |
| | Volume threshold for shake during dispense | entry |
| | Enable shake after each dispense head | checkbox |
| | Shake duration after each dispense head | entry |
| Default fluid values | Fluid class for new fluids | drop-down |
| | Concentration and units for new fluids | entry + drop-down |
| | Dispense mode for new fluids | toggle |
| Default plate values | Plate type for new protocols | drop-down |
| | DMSO limit for new protocols | entry |
| Normalization | Default dispense order | drop-down |
| Additional volumes | Default additional volume for each plate type | drop-down + entry |
| Display – Wells | Concentration significant digits (minimum) | 2 to 8 |
| | Volume significant digits (minimum) | 2 to 8 |
| Display – Fluids | Concentration decimal places | max 4 |
| | Volume decimal places | max 4 |
| | Show more information in fluid list | checkbox |
| Reports | Auto-save reports after protocol run; Do not save aborted protocol runs | checkboxes |
| | Report name: "Name is the protocol name combined with date and time" / "Fixed name" (append "(1)" or overwrite) | radio |
| | Report formats: Excel XML, CSV, PDF, Data XML (and QuantStudio, p.86) | checkboxes |
| | Significant digits: Show all / Round to N | radio |
| | Include "Don't Dispense" fluids; Include empty wells in "Tabular detail"; Include revision history | checkboxes |
| | PDF page size Letter/A4; signature lines; digitally sign (certificate) | |
| File locations | Protocol folder; Report folder | browse |
| Run | Default to use high-volume cassettes; Show "remove plate lid" reminder; Require and validate plate ID; Do not show Help panel | checkboxes |

Numeric default values (e.g. a 1 % DMSO limit) are not stated in the text. The figures show DMSO limit 1 and threshold 100 or 1000 nL.

### 9.2 Reports (Appendix A, p.86-92)

**Formats**

- Excel-compatible XML (*.xml), with tabs.
- CSV (same content).
- PDF.
- QuantStudio (*.DA.csv).
- Data XML (*.DATA.xml).

**Tabs and fields**

- **Summary:** Protocol (path), User, Simulated/Completed (start and finish timestamps), Conditions, Software Version, Time Zone, Normalization "Dispense order" value, shake settings, and device ID (p.44).
- **Fluids**, top table: Fluid, Fluid Name, Stock Concentration, Stock Concentration Units, Class, Source Plate, Source Well, No Dispense, Dispense by Volume, Small Molecule, Dispense Heads, Loaded Volume (µL), Dispensed Volume (µL).
- **Fluids**, head table: Fluid, Fluid Name, Cassette Type, Cassette, Dispense Head, Fill Time, Loaded Volume (µL), Dispensed Volume (µL).
- **Fluids**, units table: Fluid, Fluid Name, Dispensed Concentration Units, Dispensed Volume Units.
- **Fluids**, cassette table: Cassette, Cassette ID, Cassette Type.
- **Plates:** Plate, Plate Name, Plate ID, Type, Rows, Columns, Additional Volume (µL), DMSO Limit (%), Don't Shake, Don't Dispense, Deionize, Prompt Plate Load.
- **Tabular:** one row per well, sorted by plate, then dispensed row, then column. Columns:
  - Plate ID, Plate, Dispensed Well, Dispensed Row, Dispensed Col, Non-random Well, Non-random Row, Non-random Col;
  - Well Contents (fluid name or "N fluids");
  - Single Fluid Concentration (blank if more than one fluid), Units;
  - Conc. (µM) <Fluid k> for each fluid;
  - Total Dispensed Volume (nL) (includes normalization when there is more than one fluid);
  - Volume (nL) <Fluid k> for each fluid;
  - Volume (nL) DMSO normalization;
  - Total Well Volume (nL) (= dispensed + additional);
  - DMSO %.
- **Tabular Detail:** one row per dispense event. Columns:
  - Plate ID, Plate, Dispensed Well/Row/Col, Non-random Well/Row/Col;
  - Fluid, Fluid Name, Cassette, Dispense Head (or "Multiple"), Start Time;
  - Dispensed Concentration, Units, Dispensed Volume, Units, Total Well Volume.
  - Normalization rows have no concentration. Empty-well rows are optional.
- **Spatial tabs, per plate:** "<n> Dispensed Conc", "<n> Dispensed Volume", "<n> Start Time". Each has a composite section first (single-fluid wells coloured, multi-fluid wells show the count or total), then one section per fluid.
- **Events:** protocol start/finish, plate and cassette loads, head fills, and head dispense start (col A) and end (col B).

### 9.3 Copy/paste formats (Appendix B, p.93-102)

All layouts are tab-separated rows (the Windows clipboard to Excel).

**Fluid list (Copy All Fluids):** one row per fluid, in list order. The header row is illustrative only ("should not be selected when copying"). Columns:

```
Fluid name | Stock conc. | Stock conc. units | Class | Source plate | Source well | No Dispense | Dispense by Volume
Fluid 1    | 10          | mM                | DMSO  | Source Plate1| B17         |             |
Fluid 2    | 20          | µg/mL             | DMSO  | Mother Plate | G11         | No Dispense |
Fluid 3    |             |                   | a+B   | Daughter Plate| E9         |             | By Volume
```

**Paste Fluids rules (p.94-95)**

- Rows are matched by name. Unknown names are appended as new fluids.
- "If concentration (and units) or fluid class are blank, however, the existing fluid values will not be changed."
- Any non-blank value in No Dispense or Dispense by Volume sets that flag. INFERRED: a blank value clears it, since the Figure 5 example shows a modified state. → §10.
- The user is warned before an existing list is modified.
- Replace Fluids: the pasted rows replace existing fluids positionally (the example pastes 2 names only), keeping the well assignments.

**Wells (Copy Wells), one block per fluid used in the selection (Figure 8, p.98):**

```
<Fluid name> | <stock conc> <units> | <Class> | <Source plate> | <Source well> | <No Dispense> | <Dispense mode e.g. "By Volume">
<unit e.g. µM or nL> | 1 | 2 | … | 12
A | v | v | … (blank = no fluid)
…
H | …
```

Verified from Figure 8 (p.98): stock concentration and units are two separate cells ("10" | "mM"). The header cells in order are name, conc, units, class, source plate, source well, No Dispense, dispense mode ("By Volume" lands under grid column 7). Each fluid block ends with row H, followed by one empty row before the next block. Empty wells are empty cells. Rules:

- Values are in current protocol units: concentration for by-concentration fluids, volume for by-volume fluids.
- Normalization and randomization are not copied.
- "Copy Wells only copies the selected wells".

**Paste structured well information (p.98-100)**

- Values are interpreted "using the units in the upper-left corner of the fluid headers".
- When pasting a full template, the prompt offers "Replace all fluids in the plate".
  - Checked: everything on the plate is cleared first.
  - Unchecked: only the fluids on the clipboard are replaced.
- A partial region writes only the wells inside it, and there is a warning about overwriting.
- "Only the fluid name is required in the row above the template header". Changing fluid info there modifies the Fluid list. "Empty cells in the fluid-information row will be ignored" (this differs from Paste Fluids).
- After paste, the randomization definitions are unchanged.

**Paste unstructured (p.101-102)**

- A bare grid of numbers is pasted at the target well.
- The user must pick a fluid, and values are taken "in current mode and units for the selected fluid".
- Options: "Replace all fluids in the paste region", "Transpose rows and columns".
- Not allowed if the Fluid list is empty.
- A 0 cell sets no fluid (INFERRED). → §10.

**Plate randomization:** can be copied to the Clipboard and pasted into another protocol (p.37). The format is NOT IN GUIDE.

---

## 10. Open questions (check against the real software / more .tdd files)

1. **AssayVolume semantics.** Is XML `AssayVolume` the guide's "Additional volume" (user-added, excluded from dispensing), or the total well volume? Do the per-well µM values solve C = S·V/(AssayVolume + ΣV) as in §6?
2. **Backfill mapping.** Confirm that `ToMaxVolume` = "highest class volume", not "highest total volume". What are the XML names for "specified volume", "specified total volume" and "highest total volume"? Is Param a fraction (0.01 = 1 %)? How does the XML store the normalization fluid class? Is `BackfillOrder` one of Before/After/Mixed? Is `BackfillNoDispense` protocol-wide?
3. **Not in the guide at all:** `CellDispenseMode`, `PrioritizeSurfactantFreeCassettes`, `FluidOrderRun`, and the cell-class and surfactant-free fluid classes (a figure says "Titration is disabled for cell class fluids"). Get their options, defaults and effects from the 4.0.1 UI.
4. **Cassette types.** T8+ (8 heads) appears only in figures. D4+ never appears. Find the head count and volume specs per cassette, and the rule that chooses cassette type for the 3 modes.
5. **Plate types.** The full list, well volume limits per type (a max total well volume?), whether 6/12/24/48/96/384/1536 are all supported, and the Deionize and Prompt Plate Load fields (seen only in the report).
6. **Rounding.** Is it nearest-increment (the evidence supports nearest)? How are ties and band boundaries (17 pL, 1 nL, 3.6 nL) handled? Are 13/11/12 pL single drops? How is 0 < V < min handled: drop to 0 or keep with a warning?
7. **Distributions.** Are 1/2-Log, 1/3-Log and 1/4-Log steps of 10^(1/2), 10^(1/3) and 10^(1/4)? How is Linear with an increment bounded at 0? What is the full titration-pattern set (row/column, high-first corner, serpentine?)?
8. **Targeted titration.** The tail allocation and rounding rule (proportional to log span?), and whether the target region is log- or linearly spaced.
9. **Shift/extend.** The threshold for "significantly below" the minimum. The exact choice of dilution (smallest candidate ≥ needed ratio?). Which levels the extended fluid takes. How the derived fluid is named and stored.
10. **Synergy.**
    - Whether Include "0" adds a level or replaces one.
    - Whether a replicates field exists.
    - Whether and how the DMSO limit is split between fluids (screenshots show the max dropping from 100 to 50 µM).
    - The combination order for fluids 3+.
    - The plate-break rule (prefix product vs. largest divisor).
    - The "does not leave empty wells" fill order.
    - What the "▸⧉" button does.
    - How the A\*B A\*C type places multiple secondary grids.
11. **Quick Plate.** The exact semantics of each "Example layout option" thumbnail, and whether the order of the fluid list determines placement.
12. **Load volume formula** (dead volume per cassette type, minimum fill) and how fluid total volume is split across heads.
13. **Design-time warnings.** Whether a DMSO-over-limit warning exists at design time; whether the 10 µL per fluid per well maximum is enforced; aqueous > 4 plates at run time vs. design time.
14. **Shake defaults.** p.22 says a new plate defaults to Don't Shake "depending on the selection in the Current Protocol tab". p.45 says shake-during-dispense is auto-enabled for ≤ 48-well plates. Is the per-plate flag saved? "Don't dispense plate" is not saved (p.23): confirm it is absent from .tdd.
15. **Randomization storage** in .tdd (a permutation per plate?), the RNG, and whether re-randomizing adds to the existing group.
16. **Copy/paste.** Whether blank No Dispense / By Volume cells clear the flags; how a 0 cell in an unstructured paste is treated; the randomization clipboard format; Figure 5's "3x7 array" vs. the 8-column layout.
17. **Undo** depth and redo; whether wizard creations are a single undo step.
18. **Colour.** The fluid colour palette (numbered) and the colour-saturation scale on the plate.
19. **DMSO % precision.** The p.33 tooltip says 0.911 % while 186/20373 nL = 0.913 %. Is the denominator different (e.g. excludes something)?
20. **Enzyme Profile.** The rule for the default Distribution "depending on the type of fluid", and the layout options.
