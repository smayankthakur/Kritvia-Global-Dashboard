export interface CashflowForecastResponseDto {
  outstandingReceivables: number;
  avgPaymentDelayDays: number;
  next30DaysForecast: number;
  next60DaysForecast: number;
  breakdown: {
    invoices: {
      dueIn30: number;
      dueIn60: number;
      overdue: number;
    };
    pipelineWeighted30: number;
    pipelineWeighted60: number;
  };
}

