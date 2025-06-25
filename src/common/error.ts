// * Function to create an error
const createError = (statusCode: number, errorMessage: string) => {
  const err: any = new Error();
  err.status = statusCode;
  err.message = errorMessage;

  return err;
};

export default createError;
