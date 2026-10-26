import { AppError } from './errors.js';

export function validate(schema) {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req.body);
      req.validatedBody = parsed;
      next();
    } catch (err) {
      throw new AppError('Validation error', 400, err.errors);
    }
  };
}
