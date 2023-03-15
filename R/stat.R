#!/usr/bin/Rscript --vanilla
library(optparse)
library(tidyverse)
library(ggplot2)
library(cowplot)

option_list <- list(
                    make_option(c('--dir'), dest='dir', help='data files directory'),
                    make_option(c('--data'), dest='data_name', help='dataset name')
                    )
opts <- parse_args(OptionParser(option_list=option_list));
data_name <- opts$data_name;
csv_filename <- file.path(opts$dir, paste0(data_name, '.csv'));
time_polt_png_name <- file.path(opts$dir, paste0(data_name, '-times.png'));
time_polt_pdf_name <- file.path(opts$dir, paste0(data_name, '-times.pdf'));
distri_polt_png_name <- file.path(opts$dir, paste0(data_name, '-distribution.png'));
distri_polt_pdf_name <- file.path(opts$dir, paste0(data_name, '-distribution.pdf'));

#------------------------------------------------------------------------------
# prepare and manipulate data

data <- read.csv(csv_filename);
data <- data %>% mutate(BackupAndStopUbiTime = BackupTime + UbiStopTime);

ymax <- max(data$CapacitorTime)
n_samples <- nrow(data);

#------------------------------------------------------------------------------
# Print data summary
#
backupDone <- data %>% filter(StateWhenPowerDownDetected == 'normal-opr') %>% select(BackupTime, RespDelay)
ubiStopDone <- data %>% filter(StateWhenPowerDownDetected != 'on-mains') %>% select(UbiStopTime)
print(paste0('number of samples: ', nrow(data)))
print(paste0('capacitor data: max ', max(data$CapacitorTime),
             ' mean ', mean(data$CapacitorTime)))
print(paste0('response delay: max ', max(data$RespDelay),
             ' mean ', mean(data$RespDelay)))
print(paste0('response delay when backup will run: max ', max(backupDone$RespDelay),
             ' mean ', mean(backupDone$RespDelay)))
print(paste0('backup: max ', max(data$BackupTime),
             ' mean ',mean(backupDone$BackupTime)))
print(paste0('ubi: max ', max(data$UbiStopTime),
             ' mean ',mean(ubiStopDone$UbiStopTime)))
plot_times_props <- function(y_col, title, ylab = NULL) {
    ggplot(data = data, aes(x = PowerDownStartTime, y = y_col
                                  , color=StateWhenPowerDownDispatch)) +
        geom_point() +
        ylim(0, ymax) +
        labs(title = title
             , x = 'Power down happen\n(n-th sec)'
             , y = ylab,
             , color = 'Shutdown handled in:') +
        theme(plot.margin = margin(6, 2, 6, 2),
              plot.title = element_text(hjust=0, size=9),
              axis.title = element_text(size=12)
              );
};

#------------------------------------------------------------------------------
# times plots

times_capacitor <- plot_times_props(data$CapacitorTime, 'A. Capacitor time\n(pwr-down to reset)', 'secs');
times_shutdown  <- plot_times_props(data$ShutdownTime, 'B. Shutdown time\n(handle pwr-down to reset)');
times_backup  <- plot_times_props(data$BackupTime, 'C. Backup time\n(stop tasks and save rambackup)');
times_ubi  <- plot_times_props(data$UbiStopTime, 'D. Stop UBI\n(stop UBI and save cache)');
times_resp_delay <- plot_times_props(data$RespDelay, 'E. Resp. delay\n(pwr-down to start of handling)');

prow <- plot_grid(times_capacitor + theme(legend.position = 'none'),
               times_shutdown + theme(legend.position = 'none'),
               times_backup + theme(legend.position = 'none'),
               times_ubi + theme(legend.position = 'none'),
               times_resp_delay + theme(legend.position = 'none'),
               align = 'vh',
               labels = NULL,
               vjust = 1,
               hjust = -1,
               nrow = 1
               );

# Extract a shared legend and make it horizontal layout.
#
legend <- get_legend(
    times_capacitor + guides(color = guide_legend(nrow = 1)) +
    theme(legend.position = 'bottom', legend.title.align=1, legend.title = element_text(size=9))
);

# Title for all the plots.
#
title <- ggdraw() +
  draw_label(paste0(data_name, ' - times'),
             size = 18,
             x = 0, hjust = 0, vjust = 1) +
  theme(plot.margin = margin(0, 0, 0, 7));
caption <- ggdraw() +
  draw_label(paste0('number of power cycle tests: ', nrow(data)),
             size = 10,
             x = 0, hjust = 0, vjust = 1) +
  theme(plot.margin = margin(0, 0, 10, 7));

p_times <- plot_grid(title, caption, prow, legend, ncol = 1, rel_heights=c(.06, .03, .85, .06));

ggsave(time_polt_png_name, p_times, width=12, height=12, bg = 'white');
print(paste0('saved', time_polt_png_name));
ggsave(time_polt_pdf_name, p_times, width=12, height=12, bg = 'white');
print(paste0('saved', time_polt_pdf_name));

#------------------------------------------------------------------------------
# pdf plots

plot_pdf <- function(data, x_col, xlab, ylab = NULL) {
    ggplot(data = data, aes(x = .data[[x_col]], kernel = "epanechnikov",
                            fill = StateWhenPowerDownDispatch)) +
        xlim(0, NA) +
        labs(x = xlab, y = ylab, fill = 'Shutdown handled in:') +
        geom_density(size = .1);
};

pdf_capacitor <- plot_pdf(data, 'CapacitorTime', 'Capacitor time', 'density');
pdf_backup <- plot_pdf(data, 'BackupTime', 'Backup');
pdf_stop_ubi <- plot_pdf(data, 'UbiStopTime', 'Stop UBI');
pdf_resp_delay <- plot_pdf(data, 'RespDelay', 'Resp. delay');

prow1 <- plot_grid(pdf_capacitor + theme(legend.position = 'none'),
               pdf_backup + theme(legend.position = 'none'),
               pdf_stop_ubi + theme(legend.position = 'none'),
               pdf_resp_delay + theme(legend.position = 'none'),
               align = 'vh',
               labels = NULL,
               vjust = 1,
               hjust = -1,
               nrow = 1
               );

legend1 <- get_legend(
    pdf_capacitor + guides(color = guide_legend(nrow = 1)) +
    theme(legend.position = 'bottom', legend.title.align=1, legend.title = element_text(size=9))
);

# The extreme small time can contribute a very large portion of the whole
# observations, if not exlude them, they will dominate the y-scale making the
# more useful info almost impossible to be seen.
pdf_capacitor <- plot_pdf(data %>% filter(CapacitorTime > 0.020), 'CapacitorTime', 'Capacitor time > 0.020s', 'density');
pdf_backup <- plot_pdf(data %>% filter(BackupTime > 0.010), 'BackupTime', 'Backup > 0.010s');
pdf_stop_ubi <- plot_pdf(data %>% filter(UbiStopTime > .010), 'UbiStopTime', 'Stop UBI > 0.010s');
pdf_resp_delay <- plot_pdf(data %>% filter(RespDelay > 0.016), 'RespDelay', 'Resp. delay > 0.016s');

prow2 <- plot_grid(pdf_capacitor + theme(legend.position = 'none'),
               pdf_backup + theme(legend.position = 'none'),
               pdf_stop_ubi + theme(legend.position = 'none'),
               pdf_resp_delay + theme(legend.position = 'none'),
               align = 'vh',
               labels = NULL,
               vjust = 1,
               hjust = -1,
               nrow = 1
               );

legend2 <- get_legend(
    pdf_capacitor + guides(color = guide_legend(nrow = 1)) +
    theme(legend.position = 'bottom', legend.title.align=1, legend.title = element_text(size=9))
);

title <- ggdraw() +
  draw_label(paste0(data_name, ' - time distribution'),
             size = 18,
             x = 0, hjust = 0, vjust=1) +
  theme(plot.margin = margin(0, 0, 0, 7));
p_distribution <- plot_grid(title, caption, prow1, legend1, prow2, legend2, ncol = 1, rel_heights=c(.07, 0.03, .40, .05, .40, .05));

ggsave(distri_polt_png_name, p_distribution, width=12, height=7, bg = 'white');
print(paste0('saved', distri_polt_png_name));
ggsave(distri_polt_pdf_name, p_distribution, width=12, height=7, bg = 'white');
print(paste0('saved', distri_polt_pdf_name));
