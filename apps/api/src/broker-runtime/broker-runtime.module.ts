import { Global, Module } from "@nestjs/common";
import { BrokerRuntimeService } from "./broker-runtime.service";

@Global()
@Module({
  providers: [BrokerRuntimeService],
  exports: [BrokerRuntimeService],
})
export class BrokerRuntimeModule {}
