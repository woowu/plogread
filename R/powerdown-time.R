#!/usr/bin/Rscript
library(optparse)
library(tidyverse)
library(ggplot2)

option_list <- list(
                    make_option(c('--csv'), dest='csv_filename', help='csv filename'),
                    make_option(c('--out'), dest='output_filename', help='plot filename')
                    )
opts <- parse_args(OptionParser(option_list=option_list))

times <- read.csv(opts$csv_filename);

p <- ggplot(data = times, aes(x = PowerDownStartTime, y = CapacitorTime
                              , color=StateWhenPowerDownDispatched)) +
    geom_point() +
    labs(title = 'E355 Shutdown Performance'
         , caption = paste('Data from', nrow(times), 'power cycles')
         , x = 'Power Down Detected (n-th sec)'
         , y = 'Capacitor Time (secs)'
         , color = 'Meter State')

ggsave(filename=opts$output_filename, p, dpi=300);
