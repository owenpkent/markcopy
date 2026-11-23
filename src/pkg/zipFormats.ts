// Placeholder: replaced by the real reader.
import { ReadError, type RangeReader } from '../binary/reader';
import type { PackageInfo } from './model';

export function readZipPackage(reader: RangeReader, fileName: string): Promise<PackageInfo> {
  void reader;
  void fileName;
  return Promise.reject(new ReadError('this format is not read yet.'));
}
