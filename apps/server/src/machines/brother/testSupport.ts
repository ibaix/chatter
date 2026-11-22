/** Test support for the Brother connector: replies of a real control */

/**
 * Replies of a Brother control to each command, matching the Python test fixtures
 */
export const MOCK_RESPONSES: Record<string, string> = {
  'PANEL': 'RLOD    PANEL   00\r\nD01,0,0,0\r\nK01,0,5,0,0,0,0,0,0,0,1,0\r\nS01,4,100,100,1,0,1,1\r\n\r\n10%',
  'MEM': "RLOD    MEM     00\r\nA01,'/       ',1001,0,0,0,0,0\r\n\r\n00%",
  'WKCNTR': 'RLOD    WKCNTR  00\r\nA01,  1,    78,   200,     0\r\nA02,  0,     0,     0,     0\r\n\r\n08%',
  'PDSP': "RLOD    PDSP    00\r\nX01,    0.000 ,     0,0,10,10,10,0,0,0,0,4,100,100, 0,0, 0\r\n\r\n03%",
  'ALARM': "RLOD    ALARM   00\r\nE01,0975320032,          ,          \r\n\r\n10%",
  'ATCTL': 'RLOD    ATCTL   00\r\nM02,  1,0,0\r\nM03,  2,0,0\r\n\r\n00%',
  'TOLNI1': "RLOD    TOLNI1  00\r\nT01, 1.5000, 0.0000, 0.2500, 0.0000, 0, 0, 0, 0, 'ENDMILL '\r\n\r\n00%"
};
