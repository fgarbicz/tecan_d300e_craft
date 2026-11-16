// analysis.R of the SynergyFinder package (synergy_export.js synergyPackage()). Kept as a String.raw
// template so R escapes (\n, \\.) survive verbatim; the R code must not contain backticks or "${".
// __TITLE__ is replaced with the experiment title at export.
export const ANALYSIS_R = String.raw`#!/usr/bin/env Rscript
# SynergyFinder analysis of a drug-combination screen exported by Tecan D300 Craft.
#
#   conda env create -f environment.yml          # once
#   conda run -n synergyfinder Rscript analysis.R
#
# Reads  data/synergyfinder_input.csv, data/block_map.csv          (next to this script)
# Writes results/*.csv, results/synergyfinder_result.rds, results/figure_manifest.csv
#        figures/<block>/*.{png,pdf,svg,rds}, figures/summary_*.{png,pdf,svg,rds}
# The package folder can be moved anywhere: paths are relative to this script's own folder
# (override with the environment variable SYNERGY_PACKAGE_DIR).
#
# Exit status: 0 when every figure was written in every available format; 1 when a figure failed.
# A format whose R package is missing (svglite for SVG, ragg for PNG falls back to the png device)
# is skipped with a warning and listed as "skipped" in results/figure_manifest.csv.

# ============================== options ==============================
OPTIONS <- list(
  title            = "__TITLE__",
  methods          = c("ZIP", "HSA", "Bliss", "Loewe"),   # reference models (CalculateSynergy)
  # add "html" for interactive 3D surfaces (htmlwidgets); the app can override with SYNERGY_FORMATS="png,pdf"
  formats          = if (nzchar(Sys.getenv("SYNERGY_FORMATS"))) trimws(strsplit(Sys.getenv("SYNERGY_FORMATS"), ",")[[1]]) else c("png", "pdf", "svg", "rds"),
  dpi              = 300,                                 # PNG resolution
  width            = 6.5,                                 # figure size, inches
  height           = 5.5,
  base_size        = 11,                                  # base font size, pt
  font_family      = "",                                  # "" = device default (e.g. "Helvetica", "Arial")
  # diverging palette for synergy scores (ColorBrewer RdBu ends: colour-blind safe)
  synergy_palette  = c(antagonism = "#2166AC", additive = "#F7F7F7", synergy = "#B2182B"),
  synergy_limit    = NA,                                  # symmetric colour limit; NA = largest |score|, >= 10
  response_palette = "G",                                 # viridis option for % inhibition (A-H; "G" = mako)
  point_colour     = "#B2182B", curve_colour = "#222222", # dose-response curves
  impute           = TRUE,                                # impute missing dose pairs (ReshapeData)
  adjusted         = TRUE,                                # synergy on fitted single-drug responses
  correct_baseline = "non",                               # "non", "part" or "all"
  iteration        = 10,                                  # bootstrap iterations (blocks with replicates)
  seed             = 123,
  surfaces_3d      = TRUE
)

# ============================== setup ==============================
script_dir <- local({
  env <- Sys.getenv("SYNERGY_PACKAGE_DIR", "")
  if (nzchar(env)) return(normalizePath(env))
  a <- commandArgs(trailingOnly = FALSE)
  f <- sub("^--file=", "", a[grep("^--file=", a)])
  if (length(f)) return(dirname(normalizePath(gsub("~+~", " ", f[1], fixed = TRUE))))
  of <- tryCatch(sys.frame(1)$ofile, error = function(e) NULL)          # source("analysis.R")
  if (!is.null(of)) return(dirname(normalizePath(of)))
  getwd()
})
data_dir <- file.path(script_dir, "data")
res_dir  <- file.path(script_dir, "results")
fig_dir  <- file.path(script_dir, "figures")
if (!file.exists(file.path(data_dir, "synergyfinder_input.csv"))) {
  stop("data/synergyfinder_input.csv not found next to analysis.R (looked in ", data_dir, ").")
}

need <- c("synergyfinder", "ggplot2")
missing <- need[!vapply(need, requireNamespace, logical(1), quietly = TRUE)]
if (length(missing)) {
  stop("Missing R package(s): ", paste(missing, collapse = ", "), ". This R is ", R.home(), ".\n",
       "Create the conda environment and run the script in it:\n",
       "  conda env create -f environment.yml\n  conda run -n synergyfinder Rscript analysis.R")
}
suppressPackageStartupMessages({ library(synergyfinder); library(ggplot2) })
has <- function(pkg) requireNamespace(pkg, quietly = TRUE)
dir.create(res_dir, showWarnings = FALSE, recursive = TRUE)
dir.create(fig_dir, showWarnings = FALSE, recursive = TRUE)
set.seed(OPTIONS$seed)
# an off-screen device for lattice / ggplot_build, so nothing tries to write Rplots.pdf in the working directory
null_device <- function() { if (grDevices::dev.cur() == 1) grDevices::pdf(NULL); grDevices::dev.cur() }
null_dev <- null_device()
message("synergyfinder ", as.character(utils::packageVersion("synergyfinder")), " | ", R.version.string)
message("Package folder: ", script_dir)

# ============================== data ==============================
input <- utils::read.csv(file.path(data_dir, "synergyfinder_input.csv"), fileEncoding = "UTF-8",
                         stringsAsFactors = FALSE, check.names = FALSE)
block_map <- utils::read.csv(file.path(data_dir, "block_map.csv"), fileEncoding = "UTF-8",
                             stringsAsFactors = FALSE, check.names = FALSE)
if (!nrow(input)) stop("data/synergyfinder_input.csv has no rows: no drug pair to analyse.")
message(nrow(input), " wells in ", length(unique(input$block_id)), " block(s)")

# response = % viability; ReshapeData turns it into % inhibition (100 - viability)
res <- ReshapeData(input, data_type = "viability", impute = OPTIONS$impute, noise = FALSE,
                   seed = OPTIONS$seed, iteration = OPTIONS$iteration)
res <- CalculateSynergy(res, method = OPTIONS$methods, adjusted = OPTIONS$adjusted,
                        correct_baseline = OPTIONS$correct_baseline,
                        iteration = OPTIONS$iteration, seed = OPTIONS$seed)
res <- CalculateSensitivity(res, adjusted = OPTIONS$adjusted, correct_baseline = OPTIONS$correct_baseline,
                            iteration = OPTIONS$iteration, seed = OPTIONS$seed)
saveRDS(res, file.path(res_dir, "synergyfinder_result.rds"))

pairs <- as.data.frame(res$drug_pairs)
blocks <- sort(unique(pairs$block_id))
info <- function(b) {
  m <- block_map[block_map$block_id == b, ]
  p <- pairs[pairs$block_id == b, ]
  list(id = b, cell = if (nrow(m)) m$cell_line[1] else "", d1 = p$drug1[1], d2 = p$drug2[1],
       u1 = p$conc_unit1[1], u2 = p$conc_unit2[1],
       plates = if (nrow(m)) gsub(";", ", ", m$plates[1]) else "",
       replicate = isTRUE(p$replicate[1]))
}
slug <- function(x) { s <- gsub("[^A-Za-z0-9]+", "_", iconv(x, "UTF-8", "ASCII//TRANSLIT", sub = "")); gsub("^_+|_+$", "", s) }
block_title <- function(i) paste0(if (nzchar(i$cell)) paste0(i$cell, ": ") else "", i$d1, " \u00d7 ", i$d2)
block_dir <- function(i) file.path(fig_dir, paste0("block_", i$id, "_", slug(paste(i$cell, i$d1, i$d2))))
fmt_conc <- function(x) vapply(x, function(v) if (is.na(v)) "" else if (v == 0) "0" else format(signif(v, 3), scientific = abs(log10(v)) > 4, trim = TRUE), "")
# synergyfinder reports p-values as numbers or as text ("< 2e-324"): numeric value for tests, text for labels
p_num <- function(p) { p <- as.character(p); suppressWarnings(as.numeric(sub("^\\s*<\\s*", "", p))) }
p_text <- function(p) { p <- trimws(as.character(p)); if (!length(p) || is.na(p) || !nzchar(p)) return(NA_character_)
  if (startsWith(p, "<")) paste("p", p) else paste("p =", format.pval(p_num(p), digits = 2, eps = 1e-16)) }
fmt1 <- function(x) sub("^-(0\\.0+)$", "\\1", sprintf("%.1f", x))       # no "-0.0"
wrap <- function(x, width = 100) paste(strwrap(x, width = width), collapse = "\n")
SEP <- "  \u00b7  "

# per dose pair tables (mean over replicates; statistics only for replicated blocks)
stat_or <- function(tab, b) { if (is.null(tab)) return(NULL); t <- as.data.frame(tab); t <- t[t$block_id == b, ]; if (nrow(t)) t else NULL }
resp_cells <- function(b) {
  s <- stat_or(res$response_statistics, b)
  if (!is.null(s)) return(data.frame(conc1 = s$conc1, conc2 = s$conc2, value = s$response_mean, sd = s$response_sd, n = s$n))
  r <- as.data.frame(res$response); r <- r[r$block_id == b, ]
  a <- stats::aggregate(response ~ conc1 + conc2, data = r, FUN = mean)
  data.frame(conc1 = a$conc1, conc2 = a$conc2, value = a$response, sd = NA_real_, n = 1)
}
syn_cells <- function(b, m) {
  s <- stat_or(res$synergy_scores_statistics, b)
  if (!is.null(s)) return(data.frame(conc1 = s$conc1, conc2 = s$conc2, value = s[[paste0(m, "_synergy_mean")]],
                                     lo = s[[paste0(m, "_synergy_ci_left")]], hi = s[[paste0(m, "_synergy_ci_right")]]))
  t <- stat_or(res$synergy_scores, b)
  data.frame(conc1 = t$conc1, conc2 = t$conc2, value = t[[paste0(m, "_synergy")]], lo = NA_real_, hi = NA_real_)
}

# ============================== style ==============================
theme_sf <- function() {
  theme_minimal(base_size = OPTIONS$base_size, base_family = OPTIONS$font_family) +
    theme(plot.title = element_text(face = "bold", size = rel(1.15), hjust = 0),
          plot.subtitle = element_text(colour = "grey30", size = rel(0.9), hjust = 0, margin = margin(b = 6)),
          plot.caption = element_text(colour = "grey40", size = rel(0.75), hjust = 0),
          plot.title.position = "plot", plot.caption.position = "plot",
          axis.title = element_text(size = rel(0.95)), axis.text = element_text(colour = "grey20"),
          panel.grid.minor = element_blank(), legend.title = element_text(size = rel(0.85)),
          legend.text = element_text(size = rel(0.8)), strip.text = element_text(face = "bold"),
          plot.background = element_rect(fill = "white", colour = NA),
          plot.margin = margin(10, 12, 8, 10))
}
pal <- OPTIONS$synergy_palette
all_scores <- unlist(lapply(OPTIONS$methods, function(m) res$synergy_scores[[paste0(m, "_synergy")]]))
syn_lim <- if (is.na(OPTIONS$synergy_limit)) max(10, ceiling(max(abs(all_scores), na.rm = TRUE) / 5) * 5) else OPTIONS$synergy_limit
scale_synergy <- function(name) scale_fill_gradient2(name = name, low = pal[["antagonism"]], mid = pal[["additive"]], high = pal[["synergy"]],
                                                     midpoint = 0, limits = c(-syn_lim, syn_lim), oob = scales::squish)
# text colour for a tile: white on dark fills
ink <- function(fill) { rgb <- grDevices::col2rgb(fill) / 255; ifelse(colSums(rgb * c(0.299, 0.587, 0.114)) < 0.5, "white", "grey10") }
method_label <- c(ZIP = "ZIP", HSA = "HSA", Bliss = "Bliss", Loewe = "Loewe")
model_caption <- c(
  ZIP   = "ZIP: zero interaction potency (Yadav et al. 2015).",
  HSA   = "HSA: highest single agent.",
  Bliss = "Bliss independence.",
  Loewe = "Loewe additivity.")

# ============================== saving ==============================
manifest <- data.frame(figure = character(), block_id = integer(), format = character(), file = character(),
                       status = character(), message = character(), stringsAsFactors = FALSE)
note <- function(fig, b, fmt, file, status, msg = "") {
  manifest[nrow(manifest) + 1, ] <<- list(fig, as.integer(b), fmt, sub(paste0(script_dir, "/"), "", file, fixed = TRUE), status, msg)
}
warned <- character()
warn_once <- function(key, msg) if (!key %in% warned) { warning(msg, call. = FALSE); warned <<- c(warned, key) }
open_device <- function(fmt, file, w, h) {
  switch(fmt,
    png = if (has("ragg")) ragg::agg_png(file, width = w, height = h, units = "in", res = OPTIONS$dpi, background = "white")
          else grDevices::png(file, width = w, height = h, units = "in", res = OPTIONS$dpi, type = if (capabilities("cairo")) "cairo" else "quartz"),
    pdf = if (capabilities("cairo")) grDevices::cairo_pdf(file, width = w, height = h, family = if (nzchar(OPTIONS$font_family)) OPTIONS$font_family else "sans")
          else grDevices::pdf(file, width = w, height = h, useDingbats = FALSE),
    svg = svglite::svglite(file, width = w, height = h, bg = "white"))
}
format_available <- function(fmt) {
  if (fmt == "svg" && !has("svglite")) { warn_once("svg", "svglite is not installed: SVG figures skipped."); return(FALSE) }
  if (fmt == "png" && !has("ragg")) warn_once("png", "ragg is not installed: PNG figures use the png() device.")
  if (fmt == "html" && !(has("htmlwidgets") && has("plotly"))) { warn_once("html", "htmlwidgets/plotly not installed: HTML surfaces skipped."); return(FALSE) }
  TRUE
}
# p: ggplot or lattice object; html: optional htmlwidget for the "html" format
save_figure <- function(p, dir, name, b = NA, w = OPTIONS$width, h = OPTIONS$height, html = NULL) {
  dir.create(dir, showWarnings = FALSE, recursive = TRUE)
  for (fmt in OPTIONS$formats) {
    file <- file.path(dir, paste0(name, ".", fmt))
    if (fmt == "html" && is.null(html)) next
    if (!format_available(fmt)) { note(name, b, fmt, file, "skipped", "package missing"); next }
    ok <- tryCatch({
      if (fmt == "rds") saveRDS(p, file)
      else if (fmt == "html") htmlwidgets::saveWidget(html, file, selfcontained = FALSE, libdir = "html_lib")  # html_lib/ next to the file
      else { open_device(fmt, file, w, h); on.exit(grDevices::dev.off(), add = TRUE); print(p); grDevices::dev.off(); on.exit() }
      if (!file.exists(file) || file.info(file)$size == 0) stop("file is empty")
      TRUE
    }, error = function(e) { while (grDevices::dev.cur() > 1 && grDevices::dev.cur() != null_dev) grDevices::dev.off(); null_dev <<- null_device(); note(name, b, fmt, file, "failed", conditionMessage(e)); message("FAILED ", name, ".", fmt, ": ", conditionMessage(e)); FALSE })
    if (ok) note(name, b, fmt, file, "ok")
  }
}
safely <- function(label, b, expr) tryCatch({ null_dev <<- null_device(); expr }, error = function(e) {
  note(label, b, "all", "", "failed", conditionMessage(e)); message("FAILED ", label, " (block ", b, "): ", conditionMessage(e)); NULL })

# ============================== figures ==============================
heatmap_plot <- function(cells, i, fill_scale, title, subtitle, caption, label_fun) {
  cells$x <- factor(fmt_conc(cells$conc1), levels = fmt_conc(sort(unique(cells$conc1))))
  cells$y <- factor(fmt_conc(cells$conc2), levels = fmt_conc(sort(unique(cells$conc2))))
  cells$label <- label_fun(cells)
  p <- ggplot(cells, aes(x = x, y = y, fill = value)) +
    geom_tile(colour = "white", linewidth = 0.6) + fill_scale +
    coord_equal() +
    labs(x = paste0(i$d1, " (", i$u1, ")"), y = paste0(i$d2, " (", i$u2, ")"), title = title, subtitle = subtitle, caption = wrap(caption)) +
    theme_sf() + theme(panel.grid = element_blank(), axis.text.x = element_text(angle = 45, hjust = 1, vjust = 1)) +
    guides(fill = guide_colourbar(barheight = grid::unit(10, "lines"), barwidth = grid::unit(0.8, "lines")))
  # label colour from the rendered fill (layer data rows follow the input rows)
  cells$ink <- ink(ggplot_build(p)$data[[1]]$fill)
  p + geom_text(data = cells, aes(label = label), colour = cells$ink, size = OPTIONS$base_size * 0.24, lineheight = 0.85,
                family = OPTIONS$font_family)
}
fit_curve <- function(r, drug, i) {
  single <- if (drug == 1) r[r$conc2 == 0, c("conc1", "response")] else r[r$conc1 == 0, c("conc2", "response")]
  names(single) <- c("dose", "response")
  model <- suppressWarnings(FitDoseResponse(single))
  nz <- sort(unique(single$dose[single$dose > 0]))
  step <- if (length(nz) > 1) nz[2] / nz[1] else 3
  zero_x <- nz[1] / step                      # the 0 dose, drawn one dilution step below the lowest dose
  grid <- exp(seq(log(zero_x), log(max(nz)), length.out = 200))
  pred <- suppressWarnings(stats::predict(model, newdata = data.frame(dose = grid)))
  agg <- do.call(rbind, lapply(split(single$response, single$dose), function(v) data.frame(mean = mean(v), sd = if (length(v) > 1) stats::sd(v) else NA_real_, n = length(v))))
  agg$dose <- as.numeric(rownames(agg)); agg$x <- ifelse(agg$dose == 0, zero_x, agg$dose)
  single$x <- ifelse(single$dose == 0, zero_x, single$dose)
  list(points = single, agg = agg, curve = data.frame(x = grid, y = as.numeric(pred)), zero_x = zero_x, breaks = c(zero_x, nz))
}
dose_response_plot <- function(b, i, drug) {
  r <- as.data.frame(res$response); r <- r[r$block_id == b, ]
  f <- fit_curve(r, drug, i)
  name <- if (drug == 1) i$d1 else i$d2; unit <- if (drug == 1) i$u1 else i$u2
  ic50 <- pairs[pairs$block_id == b, paste0("ic50_", drug)][1]
  ri <- pairs[pairs$block_id == b, paste0("ri_", drug)][1]
  ggplot() +
    geom_hline(yintercept = 0, colour = "grey70", linewidth = 0.4) +
    geom_line(data = f$curve, aes(x = x, y = y), colour = OPTIONS$curve_colour, linewidth = 0.9) +
    geom_point(data = f$points, aes(x = x, y = response), colour = OPTIONS$point_colour, alpha = 0.35, size = 1.4) +
    geom_errorbar(data = f$agg[!is.na(f$agg$sd), ], aes(x = x, ymin = mean - sd, ymax = mean + sd), width = 0.06, colour = OPTIONS$point_colour) +
    geom_point(data = f$agg, aes(x = x, y = mean), colour = OPTIONS$point_colour, size = 2.6, shape = 21, fill = "white", stroke = 1) +
    scale_x_log10(breaks = f$breaks, labels = fmt_conc(c(0, f$breaks[-1]))) +
    labs(x = paste0(name, " (", unit, ")"), y = "Inhibition (%)",
         title = paste0(name, " alone \u2014 ", i$cell),
         subtitle = paste0("IC50 ", fmt_conc(ic50), " ", unit, SEP, "relative inhibition (RI) ", round(ri, 1)),
         caption = wrap(paste0("Four-parameter log-logistic fit (drc LL.4, as in synergyfinder). Points: wells; open circles: mean \u00b1 SD. ",
                          "The 0 dose is drawn one dilution step below the lowest dose."))) +
    theme_sf() + theme(axis.text.x = element_text(angle = 45, hjust = 1))
}
# synergyfinder's contour map (ggplot): our theme, palette, legend title and short concentration labels
restyle_sf <- function(p, title, subtitle, caption, legend) {
  p <- p + labs(title = title, subtitle = subtitle, caption = wrap(caption), fill = legend) + theme_sf() +
    theme(panel.grid = element_blank(), axis.text.x = element_text(angle = 45, hjust = 1, vjust = 1))
  for (ax in c("x", "y")) {
    sc <- p$scales$get_scales(ax)
    if (!is.null(sc) && is.numeric(sc$breaks) && is.character(sc$labels)) sc$labels <- fmt_conc(as.numeric(sc$labels))
  }
  suppressMessages(p + scale_synergy(legend) +
    guides(fill = guide_colourbar(title = legend, barheight = grid::unit(10, "lines"), barwidth = grid::unit(0.8, "lines"))))
}
# synergyfinder's 3D surface (lattice wireframe): short concentration labels
restyle_surface <- function(p) {
  for (ax in c("x.scales", "y.scales")) {
    sc <- p$panel.args.common$scales.3d[[ax]]
    if (is.character(sc$labels)) p$panel.args.common$scales.3d[[ax]]$labels <- fmt_conc(as.numeric(sc$labels))
  }
  p
}

for (b in blocks) {
  i <- info(b); dir <- block_dir(i); bt <- block_title(i)
  message("Block ", b, ": ", bt)
  rep_txt <- if (i$replicate) "mean over replicate wells" else "single wells"
  # dose-response matrix
  safely("response_matrix", b, {
    cells <- resp_cells(b)
    p <- heatmap_plot(cells, i,
      scale_fill_viridis_c(name = "Inhibition (%)", option = OPTIONS$response_palette, direction = -1, limits = c(min(0, cells$value, na.rm = TRUE), max(100, cells$value, na.rm = TRUE))),
      paste0("Dose-response matrix \u2014 ", bt), paste0("% inhibition (100 \u2212 % viability), ", rep_txt, if (nzchar(i$plates)) paste0(SEP, "plates ", i$plates) else ""),
      if (i$replicate) "Tile labels: mean and \u00b1 SD over replicate wells." else "Tile labels: % inhibition.",
      function(d) if (all(is.na(d$sd))) sprintf("%.0f", d$value) else sprintf("%.0f\n\u00b1%.0f", d$value, d$sd))
    save_figure(p, dir, "response_matrix", b)
  })
  for (drug in 1:2) safely(paste0("dose_response_", drug), b, {
    save_figure(dose_response_plot(b, i, drug), dir, paste0("dose_response_", slug(if (drug == 1) i$d1 else i$d2)), b, h = OPTIONS$height * 0.85)
  })
  for (m in OPTIONS$methods) {
    score <- pairs[pairs$block_id == b, paste0(m, "_synergy")][1]
    pcol <- paste0(m, "_synergy_p_value")
    pt <- if (pcol %in% names(pairs)) p_text(pairs[pairs$block_id == b, pcol][1]) else NA_character_
    sub_txt <- paste0("Mean ", method_label[[m]], " synergy score ", sprintf("%.2f", score),
                      if (!is.na(pt)) paste0(" (", pt, ")") else "", SEP, rep_txt)
    cap <- paste(model_caption[[m]], "Score = observed \u2212 expected % inhibition; > 0 synergy, < 0 antagonism (|score| > 10 is the usual threshold).")
    safely(paste0("synergy_", m, "_heatmap"), b, {
      cells <- syn_cells(b, m)
      p <- heatmap_plot(cells, i, scale_synergy(paste0(m, " score")), paste0(m, " synergy \u2014 ", bt), sub_txt,
        paste(cap, if (i$replicate) "* 95% CI excludes 0." else ""),
        function(d) paste0(fmt1(d$value), ifelse(!is.na(d$lo) & (d$lo > 0 | d$hi < 0), "*", "")))
      save_figure(p, dir, paste0("synergy_", m, "_heatmap"), b)
    })
    safely(paste0("synergy_", m, "_map"), b, {
      p <- Plot2DrugContour(res, plot_block = b, drugs = c(1, 2), plot_value = paste0(m, "_synergy"), dynamic = FALSE,
                            summary_statistic = "mean", color_range = c(-syn_lim, syn_lim),
                            high_value_color = pal[["synergy"]], low_value_color = pal[["antagonism"]])
      p <- restyle_sf(p, paste0(m, " synergy map \u2014 ", bt), sub_txt, cap, paste0(m, "\nscore"))
      save_figure(p, dir, paste0("synergy_", m, "_map"), b)
    })
    if (isTRUE(OPTIONS$surfaces_3d)) safely(paste0("synergy_", m, "_surface"), b, {
      p <- Plot2DrugSurface(res, plot_block = b, drugs = c(1, 2), plot_value = paste0(m, "_synergy"), dynamic = FALSE,
                            summary_statistic = "mean", color_range = c(-syn_lim, syn_lim), z_range = c(-syn_lim, syn_lim),
                            high_value_color = pal[["synergy"]], low_value_color = pal[["antagonism"]],
                            plot_title = paste0(m, " synergy surface \u2014 ", bt))
      html <- if ("html" %in% OPTIONS$formats && has("plotly")) Plot2DrugSurface(res, plot_block = b, drugs = c(1, 2), plot_value = paste0(m, "_synergy"), dynamic = TRUE,
                            summary_statistic = "mean", color_range = c(-syn_lim, syn_lim), z_range = c(-syn_lim, syn_lim),
                            high_value_color = pal[["synergy"]], low_value_color = pal[["antagonism"]],
                            plot_title = paste0(m, " synergy surface \u2014 ", bt)) else NULL
      save_figure(restyle_surface(p), dir, paste0("synergy_", m, "_surface"), b, html = html)
    })
  }
}

# ---------- across blocks ----------
labels <- vapply(blocks, function(b) block_title(info(b)), "")
safely("summary_synergy_scores", NA, {
  long <- do.call(rbind, lapply(OPTIONS$methods, function(m) {
    pv <- if (paste0(m, "_synergy_p_value") %in% names(pairs)) p_num(pairs[[paste0(m, "_synergy_p_value")]]) else rep(NA_real_, nrow(pairs))
    data.frame(block_id = pairs$block_id, method = m, score = pairs[[paste0(m, "_synergy")]], p = pv)
  }))
  long$block <- factor(labels[match(long$block_id, blocks)], levels = rev(labels))
  long$method <- factor(long$method, levels = OPTIONS$methods)
  long$label <- paste0(fmt1(long$score), ifelse(!is.na(long$p) & long$p < 0.05, "*", ""))
  p <- ggplot(long, aes(x = score, y = block, fill = score)) +
    annotate("rect", xmin = -10, xmax = 10, ymin = -Inf, ymax = Inf, fill = "grey93") +
    geom_vline(xintercept = 0, colour = "grey50", linewidth = 0.4) +
    geom_col(width = 0.7, colour = "grey30", linewidth = 0.2) +
    geom_text(aes(label = label, hjust = ifelse(score >= 0, -0.15, 1.15)), size = OPTIONS$base_size * 0.25, family = OPTIONS$font_family) +
    facet_wrap(~method, nrow = 1) + scale_synergy("Score") +
    scale_x_continuous(expand = expansion(mult = 0.25)) +
    labs(x = "Mean synergy score over the dose matrix", y = NULL, title = paste0("Synergy scores \u2014 ", OPTIONS$title),
         subtitle = paste0(length(blocks), " block(s): cell line \u00d7 drug pair"),
         caption = "Grey band: |score| < 10 (likely additive). * p < 0.05 (bootstrap over replicate wells).") +
    theme_sf() + theme(legend.position = "none", panel.grid.major.y = element_blank())
  save_figure(p, fig_dir, "summary_synergy_scores", NA, w = max(OPTIONS$width, 2.2 * length(OPTIONS$methods) + 2), h = max(3, 1.2 + 0.45 * length(blocks)))
})
safely("summary_sensitivity_synergy", NA, {
  m <- if ("ZIP" %in% OPTIONS$methods) "ZIP" else OPTIONS$methods[1]
  d <- data.frame(css = pairs$css, score = pairs[[paste0(m, "_synergy")]], block = labels[match(pairs$block_id, blocks)])
  p <- ggplot(d, aes(x = css, y = score, fill = score)) +
    annotate("rect", xmin = -Inf, xmax = Inf, ymin = -10, ymax = 10, fill = "grey93") +
    geom_hline(yintercept = 0, colour = "grey50", linewidth = 0.4) +
    geom_point(shape = 21, size = 3.5, colour = "grey20") + scale_synergy(paste0(m, " score")) +
    (if (has("ggrepel")) ggrepel::geom_text_repel(aes(label = block), size = OPTIONS$base_size * 0.25, family = OPTIONS$font_family, min.segment.length = 0)
     else geom_text(aes(label = block), vjust = -1, size = OPTIONS$base_size * 0.25)) +
    labs(x = "Combination sensitivity score (CSS)", y = paste0(m, " synergy score"),
         title = paste0("Sensitivity vs synergy \u2014 ", OPTIONS$title),
         caption = "CSS: Malyutina et al. 2019. Upper right = efficacious and synergistic.") +
    theme_sf() + theme(legend.position = "none")
  save_figure(p, fig_dir, "summary_sensitivity_synergy", NA)
})

# ============================== tables ==============================
num_cols <- function(d) { d <- as.data.frame(d); for (n in names(d)) if (is.list(d[[n]])) d[[n]] <- unlist(d[[n]]); d }
summary_tab <- merge(block_map, num_cols(pairs), by = c("block_id", "drug1", "drug2", "conc_unit1", "conc_unit2"), all.y = TRUE, sort = TRUE)
utils::write.csv(summary_tab, file.path(res_dir, "synergy_summary_by_block.csv"), row.names = FALSE, fileEncoding = "UTF-8")
by_dose <- if (!is.null(res$synergy_scores_statistics)) {
  merge(num_cols(res$synergy_scores), num_cols(res$synergy_scores_statistics), by = c("block_id", "conc1", "conc2"), all.x = TRUE, sort = TRUE)
} else num_cols(res$synergy_scores)
resp <- do.call(rbind, lapply(blocks, function(b) cbind(block_id = b, resp_cells(b))))
names(resp)[names(resp) %in% c("value", "sd", "n")] <- c("inhibition_mean", "inhibition_sd", "n_wells")
by_dose <- merge(merge(pairs[, c("block_id", "drug1", "drug2", "conc_unit1", "conc_unit2")], resp, by = "block_id"), by_dose,
                 by = c("block_id", "conc1", "conc2"), all.x = TRUE, sort = TRUE)
by_dose <- merge(block_map[, c("block_id", "cell_line")], by_dose, by = "block_id", sort = TRUE)
utils::write.csv(by_dose, file.path(res_dir, "synergy_scores_by_dose.csv"), row.names = FALSE, fileEncoding = "UTF-8")
sens_cols <- intersect(c("block_id", "drug1", "drug2", "ic50_1", "ic50_2", "ri_1", "ri_2", "css1_ic502", "css2_ic501", "css"), names(pairs))
sens <- merge(block_map[, c("block_id", "cell_line")], pairs[, sens_cols], by = "block_id", sort = TRUE)
if (!is.null(res$sensitivity_scores_statistics)) sens <- merge(sens, num_cols(res$sensitivity_scores_statistics), by = "block_id", all.x = TRUE, sort = TRUE)
utils::write.csv(sens, file.path(res_dir, "sensitivity_by_block.csv"), row.names = FALSE, fileEncoding = "UTF-8")
writeLines(utils::capture.output(utils::sessionInfo()), file.path(res_dir, "session_info.txt"))
utils::write.csv(manifest, file.path(res_dir, "figure_manifest.csv"), row.names = FALSE, fileEncoding = "UTF-8")

# ============================== report ==============================
cat("\nSynergy scores (mean over the dose matrix):\n")
print(cbind(block = labels[match(pairs$block_id, blocks)], round(pairs[, paste0(OPTIONS$methods, "_synergy"), drop = FALSE], 2)), row.names = FALSE)
tab <- table(manifest$status)
cat("\nFigures:", paste(names(tab), tab, sep = " = ", collapse = ", "), "\n")
failed <- manifest[manifest$status == "failed", ]
if (nrow(failed)) {
  cat("FAILED:\n"); print(failed[, c("figure", "block_id", "format", "message")], row.names = FALSE)
  quit(status = 1)
}
cat("Done. Results in", res_dir, "and figures in", fig_dir, "\n")
`;
