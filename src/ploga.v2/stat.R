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
distri_polt_png_name <- file.path(opts$dir, paste0(data_name, '-distribution.png'));
distri_polt_pdf_name <- file.path(opts$dir, paste0(data_name, '-distribution.pdf'));

#------------------------------------------------------------------------------
# prepare and manipulate data

data <- read.csv(csv_filename) %>% filter(ColdStart == 'false');
xmax <- max(data$CapacitorTime)
n_samples <- nrow(data);

#------------------------------------------------------------------------------
# pdf plots

plot_pdf <- function(data, col, xlab, ylab) {
    # TODO: how to avoid this stupid?
    #
    if (col == 'CapacitorTime') {
        mu <- ddply(data, 'ShutdownType', summarise, grp.max = max(CapacitorTime)
                    , grp.mean = mean(CapacitorTime));
    } else if (col == 'BackupTime') {
        mu <- ddply(data, 'ShutdownType', summarise, grp.max = max(BackupTime)
                    , grp.mean = mean(BackupTime));
    } else if (col == 'WrShutdownReason') {
        mu <- ddply(data, 'ShutdownType', summarise, grp.max = max(WrShutdownReason)
                    , grp.mean = mean(WrShutdownReason));
    }

    p <- ggplot(data = data, aes(x = .data[[col]], kernel = "epanechnikov",
                            fill = ShutdownType)) +
        geom_density(size = .1) +
        #xlim(0, xmax) +
        labs(x = xlab, y = ylab, fill = NULL);
    p <- p + 
        geom_vline(data = mu, aes(xintercept = grp.max, color = ShutdownType),
                   linetype='dashed', size = .2);
    p <- p + 
        geom_vline(data = mu, aes(xintercept = grp.mean, color = ShutdownType),
                   linetype='dashed', size = .2);
    return(p);
};

pdf_capacitor <- plot_pdf(data, 'CapacitorTime', 'Capacitor time', ylab = 'density');
pdf_backup <- plot_pdf(data, 'BackupTime', 'Backup', ylab = NULL);
pdf_wrShutdownReason <- plot_pdf(data, 'WrShutdownReason', 'Wr Shutdown Reason'
                                 , ylab = NULL);

prow1 <- plot_grid(pdf_capacitor + theme(legend.position = 'none'),
               pdf_backup + theme(legend.position = 'none'),
               pdf_wrShutdownReason + theme(legend.position = 'none'),
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

caption <- ggdraw() +
  draw_label(paste0(n_samples, ' samples'),
             size = 10,
             x = 0, hjust = 0, vjust = 1) +
  theme(plot.margin = margin(0, 0, 10, 7));

p_distribution <- plot_grid(title,
                            caption,
                            prow1,
                            legend,
                            ncol = 1,
                            rel_heights=c(.07, .05, .83, .05)
                            );

ggsave(distri_polt_png_name, p_distribution, width=12, height=6, bg = 'white');
print(paste0('saved', distri_polt_png_name));
ggsave(distri_polt_pdf_name, p_distribution, width=12, height=6, bg = 'white');
print(paste0('saved', distri_polt_pdf_name));
