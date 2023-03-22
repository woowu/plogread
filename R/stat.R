#!/usr/bin/Rscript --vanilla
library(optparse)
library(plyr)
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
#data <- data %>% filter(PdDetectedState != 'on-mains');
#excluded_samples <- n_samples - nrow(data);

#------------------------------------------------------------------------------
# Print data summary
#
backupDone <- data %>% filter(PdDetectedState == 'normal-opr') %>% select(BackupTime, RespDelay)
ubiStopDone <- data %>% filter(PdDetectedState != 'on-mains') %>% select(UbiStopTime)
print(paste0('ttl. number of samples: ', n_samples
             #, ' (excl. power down in on-mains = ', excluded_samples, ')'
             ))
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

#------------------------------------------------------------------------------
# times plots

plot_times_props <- function(y_col, title, ylab = NULL) {
    ggplot(data = data, aes(x = PdStartTime, y = y_col
                                  , color=PdDetectedState)) +
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
  draw_label(paste0(data_name, ' - Times'),
             size = 18,
             x = 0, hjust = 0, vjust = 1) +
  theme(plot.margin = margin(0, 0, 0, 7));
caption <- ggdraw() +
  draw_label(paste0('ttl. number of samples: ', n_samples
                    #, ' (excl. power down in on-mains = ', excluded_samples, ')'
                    ),
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

plot_pdf <- function(data, col, xlab, ylab, max_line) {
    # TODO: how to avoid this stupid?
    #
    if (col == 'CapacitorTime') {
        mu <- ddply(data, 'PdDetectedState', summarise, grp.max = max(CapacitorTime));
    } else if (col == 'BackupTime') {
        mu <- ddply(data, 'PdDetectedState', summarise, grp.max = max(BackupTime));
    } else if (col == 'UbiStopTime') {
        mu <- ddply(data, 'PdDetectedState', summarise, grp.max = max(UbiStopTime));
    } else if (col == 'RespDelay') {
        mu <- ddply(data, 'PdDetectedState', summarise, grp.max = max(RespDelay));
    } else if (col == 'UbiStartTime') {
        mu <- ddply(data, 'PdDetectedState', summarise, grp.max = max(UbiStartTime));
    } else if (col == 'NormalOprStartupTime') {
        mu <- ddply(data, 'PdDetectedState', summarise, grp.max = max(NormalOprStartupTime));
    }

    p <- ggplot(data = data, aes(x = .data[[col]], kernel = "epanechnikov",
                            fill = PdDetectedState)) +
        geom_density(size = .1) +
        xlim(0, NA) +
        labs(x = xlab, y = ylab, fill = 'Shutdown handled in:');
    if (max_line) {
        p <- p + 
            geom_vline(data = mu, aes(xintercept = grp.max, color = PdDetectedState),
                       linetype='dashed', size = .2);
    }
    return(p);
};

pdf_capacitor <- plot_pdf(data, 'CapacitorTime', 'Capacitor time',
                          ylab = 'density', max_line = TRUE);
pdf_backup <- plot_pdf(data, 'BackupTime', 'Backup',
                       ylab = NULL, max_line = TRUE);
pdf_stop_ubi <- plot_pdf(data, 'UbiStopTime', 'Stop UBI',
                         ylab = NULL, max_line = TRUE);
pdf_resp_delay <- plot_pdf(data, 'RespDelay', 'Resp. delay',
                           ylab = NULL, max_line = TRUE);
pdf_start_ubi <- plot_pdf(data, 'UbiStartTime', 'Start UBI',
                          ylab = NULL, max_line = TRUE);
pdf_normal_opr_startup <- plot_pdf(data, 'NormalOprStartupTime', 'Normal mode startup',
                                   ylab = NULL, max_line = TRUE);

prow1 <- plot_grid(pdf_capacitor + theme(legend.position = 'none'),
               pdf_backup + theme(legend.position = 'none'),
               pdf_resp_delay + theme(legend.position = 'none'),
               align = 'vh',
               labels = NULL,
               vjust = 1,
               hjust = -1,
               nrow = 1
               );

prow2 <- plot_grid(pdf_start_ubi + theme(legend.position = 'none'),
               pdf_stop_ubi + theme(legend.position = 'none'),
               pdf_normal_opr_startup + theme(legend.position = 'none'),
               align = 'vh',
               labels = NULL,
               vjust = 1,
               hjust = -1,
               nrow = 1
               );

legend <- get_legend(
    pdf_capacitor + guides(fill = guide_legend(nrow = 1), color='none') +
    theme(legend.position = 'bottom', legend.title.align=1,
          legend.title = element_text(size=9))
);

title <- ggdraw() +
  draw_label(paste0(data_name, ' - Time distribution'),
             size = 18,
             x = 0, hjust = 0, vjust=1) +
  theme(plot.margin = margin(0, 0, 0, 7));

p_distribution <- plot_grid(title,
                            caption,
                            prow1,
                            prow2,
                            legend,
                            ncol = 1,
                            rel_heights=c(.07, 0.03, .425, .425, .05)
                            );

ggsave(distri_polt_png_name, p_distribution, width=12, height=6, bg = 'white');
print(paste0('saved', distri_polt_png_name));
ggsave(distri_polt_pdf_name, p_distribution, width=12, height=6, bg = 'white');
print(paste0('saved', distri_polt_pdf_name));
