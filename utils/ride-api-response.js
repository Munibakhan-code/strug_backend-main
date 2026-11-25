/** Consistent JSON shape for rideshare HTTP responses: { successful, message, ...data } */

export function rideFail(res, status, message, extra = {}) {
  return res.status(status).json({ successful: false, message, ...extra });
}

export function rideOk(res, body = {}, status = 200) {
  return res.status(status).json({ successful: true, ...body });
}
