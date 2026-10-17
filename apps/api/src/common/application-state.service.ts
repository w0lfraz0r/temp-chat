import { Injectable, ServiceUnavailableException } from '@nestjs/common';

@Injectable()
export class ApplicationState {
  private draining = false;

  get accepting() {
    return !this.draining;
  }

  drain() {
    this.draining = true;
  }

  assertAccepting() {
    if (this.draining)
      throw new ServiceUnavailableException('Service is shutting down.');
  }
}
