#!/usr/bin/Rscript
library(optparse)
#library(tidyverse)
library(dplyr)
library(tidyr)
library(ggplot2)
library(cowplot)

option_list <- list(
                    make_option(c('--csv'), dest='csv_filename', help='csv filename'),
                    make_option(c('--out'), dest='output_filename', help='plot filename')
                    )
opts <- parse_args(OptionParser(option_list=option_list))
data <- read.csv(opts$csv_filename);

ymax <- max(data$CapacitorTime)
n_samples <- nrow(data);

plot_property <- function(y_col, title, ylab) {
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

p_capacitor <- plot_property(data$CapacitorTime, 'A. Capacitor time\n(pwr-down to reset)', 'secs');
p_shutdown  <- plot_property(data$ShutdownTime, 'B. Shutdown time\n(handle pwr-down to reset)', NULL);
p_backup  <- plot_property(data$BackupTime, 'C. Backup time\n(stop tasks and save rambackup)', NULL);
p_ubi  <- plot_property(data$UbiStopTime, 'D. Stop UBI\n(stop UBI and save cache)', NULL);
p_resp_delay  <- plot_property(data$RespDelay, 'E. Resp. delay\n(pwr-down to start of handling)', NULL);

p_capacitor;
prow <- plot_grid(p_capacitor + theme(legend.position = 'none'),
               p_shutdown + theme(legend.position = 'none'),
               p_backup + theme(legend.position = 'none'),
               p_ubi + theme(legend.position = 'none'),
               p_resp_delay + theme(legend.position = 'none'),
               align = 'vh',
               labels = NULL,
               vjust = 1,
               hjust = -1,
               nrow = 1
               );

# Extract a shared legend and make it horizontal layout.
#
legend <- get_legend(
    p_capacitor + guides(color = guide_legend(nrow = 1)) +
    theme(legend.position = 'bottom', legend.title.align=1, legend.title = element_text(size=9))
);

# Title for all the plots.
#
title <- ggdraw() +
  draw_label("E355-main shutdown performace",
             size = 18,
             x = 0, hjust = 0, vjust=1) +
  theme(plot.margin = margin(0, 0, 0, 7));
caption <- ggdraw() +
  draw_label(paste0('number of power cycle tests: ', nrow(data)),
             size = 10,
             x = 0, hjust = 0, vjust=1) +
  theme(plot.margin = margin(0, 0, 10, 7));

p <- plot_grid(title, caption, prow, legend, ncol = 1, rel_heights=c(.06, .03, .85, .06));

if (! is.null(opts$output_filename)) {
    ggsave(filename=opts$output_filename, p, width=12, height=12, bg = 'white');
}

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
