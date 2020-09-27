import type { Request } from "express";

export interface RequestInterface {
  headers: { [key: string]: any };
  query: { [key: string]: any };
  body: { [key: string]: any };
}

import { Headers, Options } from "../responses/response";

export class OAuthRequest implements RequestInterface {
  body: { [key: string]: any };
  headers: Headers = {};
  query: { [key: string]: any };

  constructor(options: Options = {}) {
    this.headers = {
      ...options.headers,
    };
    this.query = {
      ...options.query,
    };
    this.body = {
      ...options.body,
    };
  }

  set(fieldOrHeaders: string, value: any): void {
    this.headers[fieldOrHeaders.toLowerCase()] = value;
  }
}
