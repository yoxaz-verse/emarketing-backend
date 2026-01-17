import { Request, Response, NextFunction } from 'express';

export function requireBootstrapKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const key = req.headers['x-bootstrap-key'];

  if (!key || key !== "obaol-bootstrap-2025") {
    return res.status(403).json({ error: 'Invalid bootstrap key' });
  }

  next();
}
