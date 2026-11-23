import { useEffect, useRef, useState } from 'react';
import { fetchFileTree } from '../../api/machineFiles';
import type { FTPTreeNode } from '../../types';
import { errorMessageOf } from '../../utils/errorMessage';

/**
 * The machine's file tree, for the folder that is open now.
 * Nothing loads until `isWanted` is true: each list is an FTP login on the machine.
 */
export function useMachineFiles(machineId: string, isWanted: boolean) {
  const [files, setFiles] = useState<FTPTreeNode[]>([]);
  // True when the server cut the list short, because the machine has too many files
  const [isCutShort, setIsCutShort] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState('/');
  // New uploads go to the folder that was loaded last
  const [uploadPath, setUploadPath] = useState('/');
  // A folder takes a second or two to load. Only the newest request may change the list,
  // so a slow answer for the folder before cannot replace the folder that is open now.
  const newestRequest = useRef(0);

  const refresh = async (path: string = currentPath) => {
    const request = ++newestRequest.current;
    const isNewest = () => request === newestRequest.current;
    setLoading(true);
    setError(null);
    try {
      const tree = await fetchFileTree(machineId, path);
      if (!isNewest()) return;
      setFiles(tree.nodes);
      setIsCutShort(tree.isCutShort);
      setUploadPath(path);
    } catch (err) {
      if (isNewest()) setError(errorMessageOf(err, 'Unknown error'));
    } finally {
      if (isNewest()) setLoading(false);
    }
  };

  const openFolder = (path: string) => {
    setCurrentPath(path);
    refresh(path);
  };

  useEffect(() => {
    if (isWanted) refresh();
    // Load again only when the machine changes, or when the list is wanted the first time
  }, [machineId, isWanted]);

  return { files, isCutShort, loading, error, currentPath, uploadPath, refresh, openFolder };
}

export type MachineFiles = ReturnType<typeof useMachineFiles>;
