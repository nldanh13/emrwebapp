from __future__ import annotations

import unittest

from bhyt.working_age import (
    flag_working_age,
    is_likely_working_age,
    is_likely_working_age_by_age,
    labor_retirement_age_years,
)


class WorkingAgeTests(unittest.TestCase):
    def test_retirement_age_caps(self):
        # Nam tối đa 62 (từ 2028), nữ tối đa 60 (từ 2035).
        self.assertAlmostEqual(labor_retirement_age_years(2030, False), 62.0)
        self.assertAlmostEqual(labor_retirement_age_years(2040, True), 60.0)
        # Năm 2021: Nam 60y3m, Nữ 55y4m.
        self.assertAlmostEqual(labor_retirement_age_years(2021, False), 60 + 3 / 12)
        self.assertAlmostEqual(labor_retirement_age_years(2021, True), 55 + 4 / 12)

    def test_child_excluded(self):
        self.assertFalse(is_likely_working_age(2020, "Nam", 2026))  # 6 tuổi

    def test_adult_included(self):
        self.assertTrue(is_likely_working_age(1990, "Nam", 2026))
        self.assertTrue(is_likely_working_age(2000, "Nữ", 2026))

    def test_retiree_excluded(self):
        self.assertFalse(is_likely_working_age(1950, "Nam", 2026))  # 76 tuổi

    def test_missing_birth_year_not_excluded(self):
        self.assertTrue(is_likely_working_age("", "Nam", 2026))
        self.assertTrue(is_likely_working_age("khong ro", "Nữ", 2026))

    def test_female_lower_cap_than_male(self):
        # Nữ 58 tuổi (ref 2026): ngưỡng nữ ~56.7 → ngoài; nam cùng tuổi → trong.
        self.assertFalse(is_likely_working_age_by_age(58, "Nữ", 2026))
        self.assertTrue(is_likely_working_age_by_age(58, "Nam", 2026))

    def test_by_age_missing_not_excluded(self):
        self.assertTrue(is_likely_working_age_by_age("", "Nam", 2026))
        self.assertTrue(is_likely_working_age_by_age(0, "Nữ", 2026))


class FlagWorkingAgeTests(unittest.TestCase):
    def test_flags_each_patient_and_keeps_fields(self):
        patients = [
            {"ho_ten": "A", "nam_sinh": "1990", "gioi_tinh": "Nam", "tuoi": "36", "ma_bn": "BN1"},
            {"ho_ten": "B", "nam_sinh": "2015", "gioi_tinh": "Nữ", "tuoi": "11", "ma_bn": "BN2"},
        ]
        out = flag_working_age(patients, 2026)
        self.assertEqual(len(out), 2)
        self.assertTrue(out[0]["working_age"])   # 36 tuổi → còn lao động
        self.assertFalse(out[1]["working_age"])  # 11 tuổi → trẻ em, loại
        # Giữ nguyên các field hiển thị để đối chiếu với EMR.
        self.assertEqual(out[0]["ho_ten"], "A")
        self.assertEqual(out[0]["ma_bn"], "BN1")
        self.assertEqual(out[1]["nam_sinh"], "2015")

    def test_falls_back_to_birth_year_without_age_column(self):
        # Không có cột tuổi → lọc theo năm sinh.
        out = flag_working_age([{"ho_ten": "C", "nam_sinh": "1950", "gioi_tinh": "Nam"}], 2026)
        self.assertFalse(out[0]["working_age"])  # 76 tuổi
        self.assertEqual(out[0]["tuoi"], "")


if __name__ == "__main__":
    unittest.main()
