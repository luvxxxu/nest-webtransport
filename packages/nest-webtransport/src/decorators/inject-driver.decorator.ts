import { Inject } from '@nestjs/common';

import { WEBTRANSPORT_DRIVER } from '../module/tokens.js';

export const InjectWebTransportDriver = (): ParameterDecorator => Inject(WEBTRANSPORT_DRIVER);
