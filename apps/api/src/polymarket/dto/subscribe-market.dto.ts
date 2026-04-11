import { IsArray, IsString, ArrayMaxSize } from 'class-validator';

export class SubscribeMarketDto {
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(500)
  assetIds: string[];
}
