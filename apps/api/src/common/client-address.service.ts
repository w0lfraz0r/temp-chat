import { Inject, Injectable } from '@nestjs/common';
import proxyaddr from 'proxy-addr';
import type { IncomingMessage } from 'node:http';
import { AppConfig } from '../config/app-config';

@Injectable()
export class ClientAddressService {
  readonly trust;

  constructor(@Inject(AppConfig) config: AppConfig) {
    this.trust = proxyaddr.compile(config.trustedProxies);
  }

  address(request: IncomingMessage) {
    return proxyaddr(request, this.trust);
  }
}
