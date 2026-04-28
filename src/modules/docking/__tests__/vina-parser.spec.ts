import { parseVinaPdbqt } from '../vina-parser';

const SAMPLE = `MODEL 1
REMARK VINA RESULT:    -8.500    0.000    0.000
REMARK INTER + INTRA:        -9.000
ATOM      1  C1  LIG A   1       1.234   2.345   3.456  1.00  0.00     0.000 C
ATOM      2  N1  LIG A   1       1.500   2.500   3.500  1.00  0.00     0.000 N
ATOM      3  H1  LIG A   1       1.100   2.100   3.100  1.00  0.00     0.000 HD
ATOM      4  O1  LIG A   1       1.700   2.700   3.700  1.00  0.00     0.000 OA
ENDMDL
MODEL 2
REMARK VINA RESULT:    -8.300    1.234    2.345
ATOM      1  C1  LIG A   1       1.300   2.400   3.500  1.00  0.00     0.000 C
ATOM      2  N1  LIG A   1       1.600   2.600   3.600  1.00  0.00     0.000 N
ATOM      3  H1  LIG A   1       1.200   2.200   3.200  1.00  0.00     0.000 HD
ATOM      4  O1  LIG A   1       1.800   2.800   3.800  1.00  0.00     0.000 OA
ENDMDL
`;

describe('parseVinaPdbqt', () => {
  it('returns one DockingPose per MODEL block', () => {
    const poses = parseVinaPdbqt(SAMPLE);
    expect(poses).toHaveLength(2);
  });

  it('extracts affinity + RMSD bounds from REMARK VINA RESULT', () => {
    const [first, second] = parseVinaPdbqt(SAMPLE);
    expect(first.rank).toBe(1);
    expect(first.affinity).toBeCloseTo(-8.5);
    expect(first.rmsdLb).toBeCloseTo(0.0);
    expect(first.rmsdUb).toBeCloseTo(0.0);
    expect(second.rank).toBe(2);
    expect(second.affinity).toBeCloseTo(-8.3);
    expect(second.rmsdLb).toBeCloseTo(1.234);
    expect(second.rmsdUb).toBeCloseTo(2.345);
  });

  it('parses ATOM coordinates and PDBQT atom-type → element mapping', () => {
    const [first] = parseVinaPdbqt(SAMPLE);
    expect(first.atoms).toHaveLength(4);
    expect(first.atoms[0]).toEqual({ serial: 1, element: 'C', x: 1.234, y: 2.345, z: 3.456 });
    expect(first.atoms[1]).toEqual({ serial: 2, element: 'N', x: 1.500, y: 2.500, z: 3.500 });
    expect(first.atoms[2]).toEqual({ serial: 3, element: 'H', x: 1.100, y: 2.100, z: 3.100 });
    expect(first.atoms[3]).toEqual({ serial: 4, element: 'O', x: 1.700, y: 2.700, z: 3.700 });
  });

  it('skips MODELs without REMARK VINA RESULT (corrupted output)', () => {
    const corrupt = `MODEL 1
ATOM      1  C1  LIG A   1       1.234   2.345   3.456  1.00  0.00     0.000 C
ENDMDL
MODEL 2
REMARK VINA RESULT:    -8.300    0.000    0.000
ATOM      1  C1  LIG A   1       1.300   2.400   3.500  1.00  0.00     0.000 C
ENDMDL
`;
    const poses = parseVinaPdbqt(corrupt);
    expect(poses).toHaveLength(1);
    expect(poses[0].affinity).toBeCloseTo(-8.3);
  });

  it('returns an empty array for empty input', () => {
    expect(parseVinaPdbqt('')).toEqual([]);
  });

  it('preserves rank ordering even when MODEL numbers are missing', () => {
    const noNumbers = `MODEL
REMARK VINA RESULT:    -1.000    0.000    0.000
ATOM      1  C1  LIG A   1       0.000   0.000   0.000  1.00  0.00     0.000 C
ENDMDL
MODEL
REMARK VINA RESULT:    -2.000    0.500    1.500
ATOM      1  C1  LIG A   1       1.000   1.000   1.000  1.00  0.00     0.000 C
ENDMDL
`;
    const poses = parseVinaPdbqt(noNumbers);
    expect(poses.map(p => p.rank)).toEqual([1, 2]);
  });

  it('maps aromatic-carbon "A" type to element C', () => {
    const aromatic = `MODEL 1
REMARK VINA RESULT:    -5.000    0.000    0.000
ATOM      1  CA  LIG A   1       0.000   0.000   0.000  1.00  0.00     0.000 A
ENDMDL
`;
    const [pose] = parseVinaPdbqt(aromatic);
    expect(pose.atoms[0].element).toBe('C');
  });

  it('skips malformed ATOM records but keeps the rest of the pose', () => {
    const malformed = `MODEL 1
REMARK VINA RESULT:    -7.500    0.000    0.000
ATOM      1  C1  LIG A   1       1.000   2.000   3.000  1.00  0.00     0.000 C
ATOM   BORK  C2  LIG A   1   nonsense data here                    0.000 C
ATOM      3  C3  LIG A   1       4.000   5.000   6.000  1.00  0.00     0.000 C
ENDMDL
`;
    const [pose] = parseVinaPdbqt(malformed);
    expect(pose.atoms.map(a => a.serial)).toEqual([1, 3]);
  });
});
