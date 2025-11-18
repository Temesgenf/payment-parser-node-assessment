const { createHandler } = require('@app-core/server');
const parseInstruction = require('@app/services/payment-processor/parse-instruction');

module.exports = createHandler({
  path: '/payment-instructions',
  method: 'post',
  middlewares: [],
  async handler(rc, helpers) {
    const payload = rc.body;

    try {
      const response = await parseInstruction(payload);

      // Determine HTTP status based on response status
      const httpStatus =
        response.status === 'failed'
          ? helpers.http_statuses.HTTP_400_BAD_REQUEST
          : helpers.http_statuses.HTTP_200_OK;

      return {
        status: httpStatus,
        data: response,
      };
    } catch (error) {
      // If it's an application error, extract status code from context
      if (error.isApplicationError && error.context?.status_code) {
        // Create a failed response with the error details
        const failedResponse = {
          type: error.context.parsed?.type || null,
          amount: error.context.parsed?.amount || null,
          currency: error.context.parsed?.currency || null,
          debit_account: error.context.parsed?.debit_account || null,
          credit_account: error.context.parsed?.credit_account || null,
          execute_by: error.context.parsed?.execute_by || null,
          status: 'failed',
          status_reason: error.message,
          status_code: error.context.status_code,
          accounts: error.context.accounts || [],
        };

        return {
          status: helpers.http_statuses.HTTP_400_BAD_REQUEST,
          data: failedResponse,
        };
      }

      // Re-throw if not handled
      throw error;
    }
  },
});
