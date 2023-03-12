#!/usr/bin/Rscript
library(optparse)
library(tidyverse)
library(ggplot2)
library(cowplot)

option_list <- list(
                    make_option(c('--csv'), dest='csv_filename', help='csv filename'),
                    make_option(c('--out'), dest='output_filename', help='plot filename')
                    )
opts <- parse_args(OptionParser(option_list=option_list))
times <- read.csv(opts$csv_filename);

p1 <- ggplot(data = times, aes(x = PowerDownStartTime, y = CapacitorTime
                              , color=StateWhenPowerDownDispatch)) +
    geom_point() +
    labs(title = 'Capacitor time'
         , x = 'Power down (n-th sec)'
         , y = NULL,
         , color = 'Handling at') +
    ylab(NULL) +
    theme(plot.margin = margin(6, 1, 6, 1), plot.title = element_text(hjust=1));
p2 <- ggplot(data = times, aes(x = PowerDownStartTime, y = ShutdownTime
                              , color=StateWhenPowerDownDispatch)) +
    geom_point() +
    labs(title = 'Shutdown time'
         , x = 'Power down (n-th sec)'
         , y = NULL,
         , color = 'Handling at') +
    theme(plot.margin = margin(6, 1, 6, 1), plot.title = element_text(hjust=1));

p3 <- ggplot(data = times, aes(x = PowerDownStartTime, y = UbiStopTime
                              , color=StateWhenPowerDownDispatch)) +
    geom_point() +
    labs(title = 'Stop UBI'
         , x = 'Power down (n-th sec)'
         , y = NULL,
         , color = 'Handling at') +
    theme(plot.margin = margin(6, 1, 6, 1), plot.title = element_text(hjust=1));

p4 <- ggplot(data = times, aes(x = PowerDownStartTime, y = RespDelay
                              , color=StateWhenPowerDownDispatch)) +
    geom_point() +
    labs(title = 'Resp. delay'
         , x = 'Power down (n-th sec)'
         , y = NULL,
         , color = 'Handling at') +
    theme(plot.margin = margin(6, 1, 6, 1), plot.title = element_text(hjust=1));

# Extract a shared legend and make it horizontal layout.
#
legend <- get_legend(
    p1 + guides(color = guide_legend(nrow = 1)) +
    theme(legend.position = 'bottom', legend.title.align=1)
);

prow <- plot_grid(p1 + theme(legend.position = 'none'),
               p2 + theme(legend.position = 'none'),
               p3 + theme(legend.position = 'none'),
               p4 + theme(legend.position = 'none'),
               align = 'vh',
               labels = "AUTO",
               vjust = 1,
               hjust = -1,
               nrow = 1
               );
p <- plot_grid(prow, legend, ncol = 1, rel_heights=c(1, .1));

ggsave(filename=opts$output_filename, p, width=8, height=6, dpi=300);
