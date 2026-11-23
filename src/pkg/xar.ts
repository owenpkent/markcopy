// Placeholder: replaced by the real reader.
import { ReadError, type RangeReader } from '../binary/reader';
import type { PackageInfo } from './model';

export function readXar(reader: RangeReader): Promise<PackageInfo> {
  void reader;
  return Promise.reject(new ReadError('this format is not read yet.'));
}
