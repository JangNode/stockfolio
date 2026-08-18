import { NextRequest, NextResponse } from "next/server";
import {
  findByExactName,
  findNameByCode,
  searchStocks,
} from "@/lib/stockMaster";
import { requireApproved } from "@/lib/requireApproved";

const CODE_PATTERN = /^\d{6}$/;

export async function GET(request: NextRequest) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";

  if (!query) {
    return NextResponse.json({ error: "검색어를 입력해주세요." }, { status: 400 });
  }

  try {
    if (CODE_PATTERN.test(query)) {
      const name = await findNameByCode(query);
      if (!name) {
        return NextResponse.json(
          { error: "존재하지 않는 종목코드입니다." },
          { status: 404 }
        );
      }
      return NextResponse.json({ code: query, name });
    }

    const exact = await findByExactName(query);
    if (exact) {
      return NextResponse.json(exact);
    }

    const matches = await searchStocks(query, 6);
    if (matches.length === 0) {
      return NextResponse.json(
        {
          error:
            "일치하는 종목을 찾을 수 없습니다. 종목코드로 입력해보세요.",
        },
        { status: 404 }
      );
    }
    if (matches.length === 1) {
      return NextResponse.json(matches[0]);
    }

    return NextResponse.json(
      {
        error: `여러 종목이 검색됩니다: ${matches
          .map((m) => `${m.name}(${m.code})`)
          .join(", ")}. 정확한 종목명이나 종목코드를 입력해주세요.`,
        candidates: matches,
      },
      { status: 409 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "종목 조회에 실패했습니다." },
      { status: 502 }
    );
  }
}
